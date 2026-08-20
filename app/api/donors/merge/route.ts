import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { MERGE_DONOR_SELECT, MERGE_FIELD_GROUPS, mergeFieldValues, validateMergeChoices, type MergeDonorRow } from "../../../../lib/donors/merge";
import { planDonorMergeResearchReconciliation, type FindingRef, type ReferencingFinding } from "../../../../lib/donors/merge-research";
import { logger } from "../../../../lib/logger";

type MergeBody = { survivingDonorId?: string; duplicateDonorId?: string; fieldChoices?: unknown; source?: "donor_page" | "import" };
type FindingRow = { id: string; fingerprint: string; status: "current" | "superseded" | "removed_not_found" | "unverified" };
type ReferencingRow = { id: string; donor_id: string; category: ReferencingFinding["category"]; claim: string };

// Research runs, pending evidence, and identity candidates carry no
// uniqueness constraint on donor_id, so repointing them is always a safe,
// unconditional UPDATE -- no reconciliation needed. Findings are different
// (see lib/donors/merge-research.ts): planResearchReconciliation() below
// runs the reads that decision needs and turns the result into statements
// appended to the exact same batch as everything else in this route, so
// research reconciliation is atomic with the donor archive -- if any
// statement in the batch fails, nothing commits, research included.
async function planResearchReconciliation(survivorId: string, duplicateId: string, userId: string) {
  const [duplicateFindings, survivorActiveFindings, referencingRows] = await Promise.all([
    env.DB.prepare("SELECT id, fingerprint, status FROM donor_research_findings WHERE donor_id=? AND user_id=?").bind(duplicateId, userId).all<FindingRow>(),
    env.DB.prepare("SELECT id, fingerprint FROM donor_research_findings WHERE donor_id=? AND user_id=? AND status IN ('current','unverified')").bind(survivorId, userId).all<FindingRef>(),
    env.DB.prepare("SELECT id, donor_id, category, claim FROM donor_research_findings WHERE related_donor_id=? AND user_id=? AND status IN ('current','unverified') AND donor_id!=?").bind(duplicateId, userId, duplicateId).all<ReferencingRow>(),
  ]);
  const referencingActiveFindings: ReferencingFinding[] = referencingRows.results.map((row) => ({ id: row.id, donorId: row.donor_id, category: row.category, claim: row.claim }));
  const referencingDonorIds = [...new Set(referencingActiveFindings.map((finding) => finding.donorId))];
  const activeFindingsByDonor = new Map<string, FindingRef[]>();
  await Promise.all(referencingDonorIds.map(async (donorId) => {
    const rows = await env.DB.prepare("SELECT id, fingerprint FROM donor_research_findings WHERE donor_id=? AND user_id=? AND status IN ('current','unverified')").bind(donorId, userId).all<FindingRef>();
    activeFindingsByDonor.set(donorId, rows.results);
  }));
  const plan = planDonorMergeResearchReconciliation({
    survivorId,
    duplicateFindings: duplicateFindings.results,
    survivorActiveFindings: survivorActiveFindings.results,
    referencingActiveFindings,
    activeFindingsByDonor,
  });
  const statements = [
    env.DB.prepare("UPDATE donor_research_runs SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, userId),
    env.DB.prepare("UPDATE donor_research_pending_evidence SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, userId),
    env.DB.prepare("UPDATE donor_research_identity_candidates SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, userId),
    ...plan.findingRepoints.map((findingId) => env.DB.prepare("UPDATE donor_research_findings SET donor_id=? WHERE id=?").bind(survivorId, findingId)),
    ...plan.relatedDonorRepoints.map(({ findingId, newFingerprint }) => env.DB.prepare("UPDATE donor_research_findings SET related_donor_id=?, fingerprint=? WHERE id=?").bind(survivorId, newFingerprint, findingId)),
  ];
  // Supersession: the survivor's (or another donor's) pre-existing active
  // finding always wins and is left untouched; the loser is repointed and
  // marked superseded -- never deleted, its full history stays inspectable
  // -- and every source it cited is copied onto the winner (INSERT OR
  // IGNORE so a source already cited by both is never duplicated). This is
  // "never discard a source merely because both donors referenced the same
  // finding," applied identically whether the collision came from the
  // duplicate's own findings or from another donor's connection to it.
  for (const { loserId, winnerId } of plan.findingSupersessions) {
    statements.push(env.DB.prepare("UPDATE donor_research_findings SET donor_id=?, status='superseded' WHERE id=?").bind(survivorId, loserId));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO donor_research_finding_sources (finding_id, source_id) SELECT ?, source_id FROM donor_research_finding_sources WHERE finding_id=?").bind(winnerId, loserId));
  }
  for (const { loserId, winnerId, newFingerprint } of plan.relatedDonorSupersessions) {
    statements.push(env.DB.prepare("UPDATE donor_research_findings SET related_donor_id=?, fingerprint=?, status='superseded' WHERE id=?").bind(survivorId, newFingerprint, loserId));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO donor_research_finding_sources (finding_id, source_id) SELECT ?, source_id FROM donor_research_finding_sources WHERE finding_id=?").bind(winnerId, loserId));
  }
  return statements;
}

type SharedActivityCollisionRow = { duplicate_interaction_id: string; shared_activity_id: string; duplicate_role: string | null; duplicate_source: string; survivor_interaction_id: string; survivor_role: string | null };

// The plain "UPDATE interactions SET donor_id=survivorId WHERE donor_id=
// duplicateId" below would violate interactions_shared_activity_donor_uidx
// whenever both donors already independently received the SAME shared
// activity (e.g. both were on the same broadcast text before being
// recognized as duplicates and merged). Detected and resolved here, ahead
// of that blind reassignment, following the exact same
// read-then-return-extra-batch-statements shape as
// planResearchReconciliation above: the duplicate's colliding link is
// detached (shared_activity_id cleared) and archived -- never a real SQL
// DELETE, matching interactions' own delete convention -- rather than left
// to collide with the survivor's own already-existing link to that same
// activity. If the duplicate's role was the stronger one (participant beats
// recipient -- real engagement outranks a broadcast touch), the survivor's
// surviving row is upgraded to match, so the fact that this donor actually
// participated is never lost to the merge.
async function planSharedActivityReconciliation(survivorId: string, duplicateId: string, userId: string) {
  const collisions = await env.DB.prepare(`SELECT dup.id AS duplicate_interaction_id, dup.shared_activity_id, dup.role AS duplicate_role, dup.source AS duplicate_source, surv.id AS survivor_interaction_id, surv.role AS survivor_role
    FROM interactions dup
    JOIN interactions surv ON surv.shared_activity_id = dup.shared_activity_id AND surv.donor_id = ? AND surv.user_id = ?
    WHERE dup.donor_id = ? AND dup.user_id = ? AND dup.shared_activity_id IS NOT NULL`).bind(survivorId, userId, duplicateId, userId).all<SharedActivityCollisionRow>();
  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  for (const row of collisions.results) {
    if (row.duplicate_role === "participant" && row.survivor_role === "recipient") {
      statements.push(env.DB.prepare("UPDATE interactions SET role='participant' WHERE id=?").bind(row.survivor_interaction_id));
    }
    statements.push(env.DB.prepare("UPDATE interactions SET shared_activity_id=NULL, source=? WHERE id=?").bind(`archived:${row.duplicate_source}`, row.duplicate_interaction_id));
    statements.push(env.DB.prepare("UPDATE shared_activities SET recipient_count = recipient_count - 1, updated_at=? WHERE id=?").bind(now, row.shared_activity_id));
    statements.push(env.DB.prepare("INSERT INTO shared_activity_recipient_audits (id, shared_activity_id, donor_id, user_id, action, created_at) VALUES (?,?,?,?,'removed',?)").bind(crypto.randomUUID(), row.shared_activity_id, duplicateId, userId, now));
  }
  return statements;
}

async function activeDonor(id: string, userId: string) {
  return env.DB.prepare(`SELECT ${MERGE_DONOR_SELECT} FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1`).bind(id, userId).first<MergeDonorRow>();
}

async function linkedCounts(donorId: string, userId: string) {
  const [gifts, giving, interactions, meetings, reminders, noteInteractions, contactAudits, paymentAudits, asks, paymentPlans] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) count FROM gifts WHERE donor_id=?").bind(donorId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM giving_activities WHERE donor_id=? AND owner_user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM interactions WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM interactions WHERE donor_id=? AND user_id=? AND type='meeting'").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM recommendations WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM interactions WHERE donor_id=? AND user_id=? AND type='note'").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM donor_contact_audits WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM jl_payment_assignment_audits WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM asks WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM pledge_payment_plans WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
  ]);
  return { gifts: gifts?.count ?? 0, pledges: giving?.count ?? 0, interactions: interactions?.count ?? 0, meetings: meetings?.count ?? 0, reminders: reminders?.count ?? 0, notes: (noteInteractions?.count ?? 0), contactAudits: contactAudits?.count ?? 0, paymentAudits: paymentAudits?.count ?? 0, asks: asks?.count ?? 0, paymentPlans: paymentPlans?.count ?? 0 };
}

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as MergeBody | null;
  const survivorId = body?.survivingDonorId?.trim() ?? ""; const duplicateId = body?.duplicateDonorId?.trim() ?? "";
  if (!survivorId || !duplicateId || survivorId === duplicateId) return Response.json({ error: "Choose two different active donors." }, { status: 422 });
  if (!validateMergeChoices(survivorId, duplicateId, body?.fieldChoices)) return Response.json({ error: "Choose which donor supplies every compared field." }, { status: 422 });
  const [survivor, duplicate] = await Promise.all([activeDonor(survivorId, profile.id), activeDonor(duplicateId, profile.id)]);
  if (!survivor || !duplicate) return Response.json({ error: "Both donors must be active records in your workspace." }, { status: 404 });
  const chosenCodeDonor = (body!.fieldChoices as Record<string, string>).jlCode === duplicate.id ? duplicate : survivor;
  const otherCodeDonor = chosenCodeDonor.id === survivor.id ? duplicate : survivor;
  if (!chosenCodeDonor.donor_code && !chosenCodeDonor.external_id && (otherCodeDonor.donor_code || otherCodeDonor.external_id)) return Response.json({ error: "The existing JL Code must be preserved on the surviving donor." }, { status: 422 });
  const [survivorCounts, duplicateCounts] = await Promise.all([linkedCounts(survivorId, profile.id), linkedCounts(duplicateId, profile.id)]);
  const after = mergeFieldValues(survivor, duplicate, body!.fieldChoices as Record<(typeof MERGE_FIELD_GROUPS)[number], string>);
  const movedCounts = { gifts: duplicateCounts.gifts, pledges: duplicateCounts.pledges, interactions: duplicateCounts.interactions, meetings: duplicateCounts.meetings, reminders: duplicateCounts.reminders, notes: duplicateCounts.notes, contactAudits: duplicateCounts.contactAudits, paymentAudits: duplicateCounts.paymentAudits, asks: duplicateCounts.asks, paymentPlans: duplicateCounts.paymentPlans };
  const now = Math.floor(Date.now() / 1000); const auditId = crypto.randomUUID();
  try {
    const researchStatements = await planResearchReconciliation(survivorId, duplicateId, profile.id);
    const sharedActivityStatements = await planSharedActivityReconciliation(survivorId, duplicateId, profile.id);
    await env.DB.batch([
      env.DB.prepare(`UPDATE donors SET archived_at=?,merged_into_donor_id=?,donor_code=NULL,external_source=NULL,external_id=NULL,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL`).bind(now, survivorId, now, duplicateId, profile.id),
      env.DB.prepare(`UPDATE donors SET display_name=?,last_name=?,primary_first_name=?,primary_title=?,spouse=?,spouse_first_name=?,spouse_title=?,donor_code=?,external_source=?,external_id=?,source_snapshot=?,email=?,phone=?,home_phone=?,alternate_mobile_phone=?,address=?,address_line_1=?,city=?,state=?,postal_code=?,country=?,contact_note=?,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL`).bind(after.display_name, after.last_name, after.primary_first_name, after.primary_title, after.spouse, after.spouse_first_name, after.spouse_title, after.donor_code, after.external_source, after.external_id, after.source_snapshot, after.email, after.phone, after.home_phone, after.alternate_mobile_phone, after.address, after.address_line_1, after.city, after.state, after.postal_code, after.country, after.contact_note, now, survivorId, profile.id),
      env.DB.prepare("UPDATE gifts SET donor_id=? WHERE donor_id=?").bind(survivorId, duplicateId),
      env.DB.prepare("UPDATE giving_activities SET donor_id=? WHERE donor_id=? AND owner_user_id=?").bind(survivorId, duplicateId, profile.id),
      // Must run before the blind interactions reassignment below --
      // detaches/archives any duplicate row that would otherwise collide
      // with a shared-activity link the survivor already has.
      ...sharedActivityStatements,
      env.DB.prepare("UPDATE interactions SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE recommendations SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE donor_contact_audits SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE jl_payment_assignment_audits SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      // Multiple pending asks are explicitly allowed by design -- no fuzzy
      // deduplication of asks merely because amount/purpose look similar
      // is ever attempted here; both donors' asks simply end up owned by
      // the survivor, exactly as with every other reassigned table above.
      env.DB.prepare("UPDATE asks SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE ask_changes SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      // pledge_activity_id itself never changes here -- the giving_activities
      // row keeps its own id, it only gets a new donor_id above -- so the
      // plan's link to its exact pledge stays valid automatically. Only the
      // plan's own denormalized donor_id needs to move, to stay in sync
      // with the pledge's new owner.
      env.DB.prepare("UPDATE pledge_payment_plans SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE pledge_payment_plan_changes SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      ...researchStatements,
      env.DB.prepare(`INSERT INTO donor_merge_audits (id,user_id,surviving_donor_id,archived_donor_id,field_choices_json,survivor_before_json,duplicate_before_json,survivor_after_json,moved_counts_json,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(auditId, profile.id, survivorId, duplicateId, JSON.stringify(body!.fieldChoices), JSON.stringify({ donor: survivor, counts: survivorCounts }), JSON.stringify({ donor: duplicate, counts: duplicateCounts }), JSON.stringify(after), JSON.stringify(movedCounts), body?.source === "import" ? "import" : "donor_page", now),
    ]);
    logger.info("donor_duplicate_resolved", { userId: profile.id, survivorId, duplicateId, auditId, movedRecordCount: Object.values(movedCounts).reduce((sum, count) => sum + count, 0) });
    return Response.json({ donorId: survivorId, archivedDonorId: duplicateId, auditId, movedCounts, href: `/donors/${encodeURIComponent(survivorId)}` });
  } catch (error) {
    logger.error("donor_merge_failed", error, { userId: profile.id, survivorId, duplicateId });
    return Response.json({ error: "The merge could not be completed. No records were moved or archived." }, { status: 500 });
  }
}
