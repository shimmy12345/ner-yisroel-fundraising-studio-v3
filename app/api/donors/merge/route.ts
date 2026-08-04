import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { MERGE_DONOR_SELECT, MERGE_FIELD_GROUPS, mergeFieldValues, validateMergeChoices, type MergeDonorRow } from "../../../../lib/donors/merge";
import { logger } from "../../../../lib/logger";

type MergeBody = { survivingDonorId?: string; duplicateDonorId?: string; fieldChoices?: unknown; source?: "donor_page" | "import" };

async function activeDonor(id: string, userId: string) {
  return env.DB.prepare(`SELECT ${MERGE_DONOR_SELECT} FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1`).bind(id, userId).first<MergeDonorRow>();
}

async function linkedCounts(donorId: string, userId: string) {
  const [gifts, giving, interactions, meetings, reminders, noteInteractions, contactAudits, paymentAudits] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) count FROM gifts WHERE donor_id=?").bind(donorId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM giving_activities WHERE donor_id=? AND owner_user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM interactions WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM interactions WHERE donor_id=? AND user_id=? AND type='meeting'").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM recommendations WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM interactions WHERE donor_id=? AND user_id=? AND type='note'").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM donor_contact_audits WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM jl_payment_assignment_audits WHERE donor_id=? AND user_id=?").bind(donorId, userId).first<{ count: number }>(),
  ]);
  return { gifts: gifts?.count ?? 0, pledges: giving?.count ?? 0, interactions: interactions?.count ?? 0, meetings: meetings?.count ?? 0, reminders: reminders?.count ?? 0, notes: (noteInteractions?.count ?? 0), contactAudits: contactAudits?.count ?? 0, paymentAudits: paymentAudits?.count ?? 0 };
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
  const movedCounts = { gifts: duplicateCounts.gifts, pledges: duplicateCounts.pledges, interactions: duplicateCounts.interactions, meetings: duplicateCounts.meetings, reminders: duplicateCounts.reminders, notes: duplicateCounts.notes, contactAudits: duplicateCounts.contactAudits, paymentAudits: duplicateCounts.paymentAudits };
  const now = Math.floor(Date.now() / 1000); const auditId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE donors SET archived_at=?,merged_into_donor_id=?,donor_code=NULL,external_source=NULL,external_id=NULL,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL`).bind(now, survivorId, now, duplicateId, profile.id),
      env.DB.prepare(`UPDATE donors SET display_name=?,last_name=?,primary_first_name=?,primary_title=?,spouse=?,spouse_first_name=?,spouse_title=?,donor_code=?,external_source=?,external_id=?,source_snapshot=?,email=?,phone=?,home_phone=?,alternate_mobile_phone=?,address=?,address_line_1=?,city=?,state=?,postal_code=?,country=?,contact_note=?,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL`).bind(after.display_name, after.last_name, after.primary_first_name, after.primary_title, after.spouse, after.spouse_first_name, after.spouse_title, after.donor_code, after.external_source, after.external_id, after.source_snapshot, after.email, after.phone, after.home_phone, after.alternate_mobile_phone, after.address, after.address_line_1, after.city, after.state, after.postal_code, after.country, after.contact_note, now, survivorId, profile.id),
      env.DB.prepare("UPDATE gifts SET donor_id=? WHERE donor_id=?").bind(survivorId, duplicateId),
      env.DB.prepare("UPDATE giving_activities SET donor_id=? WHERE donor_id=? AND owner_user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE interactions SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE recommendations SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE donor_contact_audits SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare("UPDATE jl_payment_assignment_audits SET donor_id=? WHERE donor_id=? AND user_id=?").bind(survivorId, duplicateId, profile.id),
      env.DB.prepare(`INSERT INTO donor_merge_audits (id,user_id,surviving_donor_id,archived_donor_id,field_choices_json,survivor_before_json,duplicate_before_json,survivor_after_json,moved_counts_json,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(auditId, profile.id, survivorId, duplicateId, JSON.stringify(body!.fieldChoices), JSON.stringify({ donor: survivor, counts: survivorCounts }), JSON.stringify({ donor: duplicate, counts: duplicateCounts }), JSON.stringify(after), JSON.stringify(movedCounts), body?.source === "import" ? "import" : "donor_page", now),
    ]);
    logger.info("donor_duplicate_resolved", { userId: profile.id, survivorId, duplicateId, auditId, movedRecordCount: Object.values(movedCounts).reduce((sum, count) => sum + count, 0) });
    return Response.json({ donorId: survivorId, archivedDonorId: duplicateId, auditId, movedCounts, href: `/donors/${encodeURIComponent(survivorId)}` });
  } catch (error) {
    logger.error("donor_merge_failed", error, { userId: profile.id, survivorId, duplicateId });
    return Response.json({ error: "The merge could not be completed. No records were moved or archived." }, { status: 500 });
  }
}
