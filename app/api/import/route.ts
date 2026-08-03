import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { buildImportPreview, FIELD_LABELS, type ColumnMapping, type ImportField, type ImportRow } from "../../../lib/import/recognition";
import { buildJlPreview, isJlSolutionsExport } from "../../../lib/import/jl-solutions";
import { matchJlDonors, sourceSnapshot, type ExistingJlDonor } from "../../../lib/import/jl-match";
import { logger } from "../../../lib/logger";
import { buildJlDonationPreview, isCompactJlDonationExport, isJlDonationExport } from "../../../lib/import/jl-donations";
import { matchJlDonationActivities, type ExistingGivingActivity, type MatchedHousehold } from "../../../lib/import/jl-donation-match";
import { chunkJsonRows } from "../../../lib/import/d1-json-chunks";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { donationExportRange, isoDate } from "../../../lib/import/jl-refresh";
import { buildPaymentCandidates, OPEN_PLEDGES_FOR_DONORS_SQL, planPaymentAssignments, type OpenPledge, type PaymentDecisionInput, type RememberedPaymentDecision } from "../../../lib/import/jl-payment-assignment";

type ImportRequest = {
  fileName?: string;
  fileHash?: string;
  rows?: ImportRow[];
  mapping?: ColumnMapping;
  updateExisting?: boolean;
  mode?: "first" | "refresh";
  paymentDecisions?: PaymentDecisionInput[];
};

const allowedFields = new Set<ImportField | "ignore">(["ignore", ...Object.keys(FIELD_LABELS) as ImportField[]]);

type FailureCategory = "unmatched_jl_codes" | "duplicate_records" | "invalid_dates" | "invalid_amounts" | "missing_required_fields" | "classification_review" | "nonfinancial_entries" | "transaction_database_errors" | "unexpected_exceptions";
type RowFailure = { row: number; category: FailureCategory; reason: string };

function reviewCategory(reason: string | null): FailureCategory {
  if (/code|required/i.test(reason ?? "")) return "missing_required_fields";
  if (/date/i.test(reason ?? "")) return "invalid_dates";
  if (/amount|negative/i.test(reason ?? "")) return "invalid_amounts";
  return "classification_review";
}

function safeDatabaseReason(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/string or blob too big|sqlite_toobig/.test(message)) return "D1 rejected an oversized bound JSON value (SQLITE_TOOBIG).";
  if (/foreign key/.test(message)) return "A matched JL household changed or was removed before the transaction completed.";
  if (/unique|constraint/.test(message)) return "The database rejected a duplicate donation fingerprint.";
  if (/no such table|no such column/.test(message)) return "The staging database schema is missing a required donation-import table or column.";
  if (/too (many|large)|limit|size/.test(message)) return "The validated donation batch exceeded a D1 transaction limit.";
  return "The database could not commit the validated donation batch.";
}

function pledgeSnapshotWithPayments(sourceSnapshot: string, fingerprints: string[]) {
  let snapshot: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(sourceSnapshot);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) snapshot = parsed;
  } catch { /* retain a safe empty snapshot for legacy malformed source context */ }
  const prior = Array.isArray(snapshot.fundraisingOsPaymentFingerprints) ? snapshot.fundraisingOsPaymentFingerprints.filter((value): value is string => typeof value === "string") : [];
  return JSON.stringify({ ...snapshot, fundraisingOsPaymentFingerprints: [...new Set([...prior, ...fingerprints])] });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: ImportRequest;
  try {
    body = await request.json() as ImportRequest;
  } catch {
    return Response.json({ error: "Invalid import request" }, { status: 400 });
  }

  const fileName = body.fileName?.trim() ?? "";
  const fileHash = body.fileHash?.trim().toLowerCase() ?? "";
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const mapping = body.mapping ?? {};
  if (!fileName || !/^[a-f0-9]{64}$/.test(fileHash) || !rows.length || rows.length > 25000) {
    return Response.json({ error: "The import file could not be validated" }, { status: 422 });
  }
  if (Object.values(mapping).some((field) => !allowedFields.has(field))) {
    return Response.json({ error: "The column mapping contains an unsupported field" }, { status: 422 });
  }
  const paymentDecisions = body.paymentDecisions ?? [];
  const decisionFingerprints = new Set<string>();
  if (!Array.isArray(paymentDecisions) || paymentDecisions.some((decision) => {
    const valid = /^[a-f0-9]{64}$/.test(decision?.fingerprint ?? "")
      && ["apply_to_pledge", "new_gift", "needs_review"].includes(decision?.action)
      && (decision.action !== "apply_to_pledge" || typeof decision.pledgeId === "string")
      && (decision.overpaymentAction === undefined || decision.overpaymentAction === null || decision.overpaymentAction === "split_remainder_new_gift");
    if (!valid || decisionFingerprints.has(decision.fingerprint)) return true;
    decisionFingerprints.add(decision.fingerprint);
    return false;
  })) return Response.json({ error: "The payment decisions could not be validated" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const existing = await env.DB.prepare("SELECT id, completed_at FROM data_imports WHERE user_id = ? AND file_hash = ? LIMIT 1").bind(userId, fileHash).first<{ id: string; completed_at: number | null }>();
  if (existing) {
    const exactDonation = isJlDonationExport(Object.keys(rows[0] ?? {}));
    const exactHousehold = isJlSolutionsExport(Object.keys(rows[0] ?? {}));
    if (exactDonation || exactHousehold) return Response.json({
      importId: existing.id, fileName, completedAt: new Date().toISOString(), profile: exactDonation ? "JL Solutions Donations" : "JL Solutions",
      mode: "refresh", databaseChangesMade: false, noChangesMade: true, imported: { donors: 0, gifts: 0, interactions: 0, reminders: 0 }, rejectedRows: [],
      donation: exactDonation ? { newActivities: 0, updatedPledges: 0, unchanged: rows.length, unknownHousehold: 0, needsReview: 0, nonfinancialExcluded: 0, duplicateSourceRows: 0 } : undefined,
      results: { validRows: rows.length, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: rows.length, rowsRequiringReview: 0, rejectedRows: 0, unmatchedJlCodes: 0, elapsedMs: 0 },
      warnings: [`This exact ${exactDonation ? "donation" : "household"} export was already processed${existing.completed_at ? ` on ${new Date(existing.completed_at * 1000).toISOString().slice(0, 10)}` : ""}. No records were duplicated.`],
    });
    return Response.json({ error: "This file has already been imported", importId: existing.id }, { status: 409 });
  }

  if (isJlDonationExport(Object.keys(rows[0] ?? {}))) {
    const startedAt = Date.now();
    try {
    const columns = Object.keys(rows[0] ?? {});
    const compactPaymentExport = isCompactJlDonationExport(columns);
    const donationPreview = await buildJlDonationPreview(rows);
    const codes = [...new Set(donationPreview.activities.map((activity) => activity.externalHouseholdId.toLowerCase()).filter(Boolean))];
    const fingerprints = donationPreview.activities.map((activity) => activity.fingerprint);
    const households = codes.length ? await env.DB.prepare(`SELECT id, external_id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(codes)).all<MatchedHousehold & { display_name: string }>() : { results: [] as Array<MatchedHousehold & { display_name: string }> };
    const prior = fingerprints.length ? await env.DB.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category, source_snapshot FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(fingerprints)).all<ExistingGivingActivity>() : { results: [] as ExistingGivingActivity[] };
    const match = matchJlDonationActivities(donationPreview, households.results, prior.results);
    const donorIds = households.results.map((household) => household.id);
    const openPledges = compactPaymentExport && donorIds.length
      ? await env.DB.prepare(OPEN_PLEDGES_FOR_DONORS_SQL).bind(userId, JSON.stringify(donorIds)).all<OpenPledge>()
      : { results: [] as OpenPledge[] };
    const remembered = compactPaymentExport && fingerprints.length
      ? await env.DB.prepare(`SELECT payment_fingerprint, decision_type, pledge_activity_id, applied_import_id FROM jl_payment_assignments WHERE user_id = ? AND payment_fingerprint IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(fingerprints)).all<RememberedPaymentDecision>()
      : { results: [] as RememberedPaymentDecision[] };
    const rememberedFingerprints = new Set(remembered.results.map((decision) => decision.payment_fingerprint));
    const rememberedWithLegacyGifts = [...remembered.results, ...prior.results.filter((activity) => !rememberedFingerprints.has(activity.source_fingerprint)).map((activity) => ({ payment_fingerprint: activity.source_fingerprint, decision_type: "new_gift" as const, pledge_activity_id: null, applied_import_id: "existing-gift" }))];
    const paymentCandidates = compactPaymentExport ? buildPaymentCandidates(donationPreview.activities, households.results, openPledges.results, rememberedWithLegacyGifts) : [];
    const assignmentPlan = compactPaymentExport ? planPaymentAssignments(paymentCandidates, paymentDecisions) : { newGifts: [], newGiftFingerprints: [] as string[], pledgeUpdates: [], assignments: [], alreadyApplied: [] as string[], errors: [] as Array<{ row: number; reason: string }> };
    const candidateByFingerprint = new Map(paymentCandidates.map((candidate) => [candidate.fingerprint, candidate]));
    const activityByFingerprint = new Map(donationPreview.activities.map((activity) => [activity.fingerprint, activity]));
    const manualNewActivities = assignmentPlan.newGifts.map((gift) => {
      const activity = activityByFingerprint.get(gift.sourceFingerprint)!;
      const candidate = candidateByFingerprint.get(gift.sourceFingerprint)!;
      return { ...activity, fingerprint: gift.fingerprint, donorId: candidate.donorId!, committedCents: gift.amountCents, paidCents: gift.amountCents, balanceCents: 0, category: "completed_gift" as const, reviewReason: null, sourceValues: { ...activity.sourceValues, fundraisingOsPaymentFingerprint: gift.sourceFingerprint, fundraisingOsAllocation: gift.kind } };
    });
    const matchedActivities = compactPaymentExport ? manualNewActivities : match.matched;
    const newActivities = compactPaymentExport ? manualNewActivities : match.newActivities;
    const proposedUpdates = compactPaymentExport ? [] : match.proposedUpdates;
    const alreadyImported = compactPaymentExport ? assignmentPlan.alreadyApplied.length : match.alreadyImported;
    const exportRange = donationExportRange(compactPaymentExport ? donationPreview.activities : match.matched);
    const reviewRows: RowFailure[] = (compactPaymentExport
      ? assignmentPlan.errors.map((error) => ({ ...error, category: reviewCategory(error.reason) }))
      : match.reviewActivities.map((activity) => ({ row: activity.rowNumber, category: reviewCategory(activity.reviewReason), reason: activity.reviewReason ?? "Row requires review" })))
      .sort((a, b) => a.row - b.row);
    const rejectedRows: RowFailure[] = [
      ...donationPreview.duplicateRows.map((duplicate) => ({ row: duplicate.row, category: "duplicate_records" as const, reason: "Duplicate source row" })),
      ...(!compactPaymentExport ? match.unknownActivities.map((activity) => ({ row: activity.rowNumber, category: "unmatched_jl_codes" as const, reason: "JL Code does not match an imported household" })) : []),
      ...match.nonfinancialActivities.map((activity) => ({ row: activity.rowNumber, category: "nonfinancial_entries" as const, reason: "Zero-dollar, complimentary, or included entry was excluded from giving history" })),
    ].sort((a, b) => a.row - b.row);
    const validationIssues = [...reviewRows, ...rejectedRows].sort((a, b) => a.row - b.row);
    const validation = { totalRows: rows.length, passedRows: compactPaymentExport ? assignmentPlan.assignments.length : matchedActivities.length, failedRows: reviewRows.length + rejectedRows.length, duplicateRows: donationPreview.duplicateRows.length + alreadyImported, nonfinancialRows: match.nonfinancial, firstErrors: validationIssues.slice(0, 10) };
    const allRowsRequireReview = reviewRows.length === rows.length && rejectedRows.length === 0 && alreadyImported === 0;
    if (allRowsRequireReview) {
      return Response.json({
        importId: `review-${fileHash.slice(0, 12)}`,
        fileName,
        completedAt: new Date().toISOString(),
        profile: "JL Solutions Donations",
        mode: body.mode === "refresh" ? "refresh" : "first",
        reviewOnly: true,
        message: "No rows were imported because every row requires review.",
        databaseChangesMade: false,
        noChangesMade: true,
        imported: { donors: 0, gifts: 0, interactions: 0, reminders: 0 },
        donation: { newActivities: 0, updatedPledges: 0, unchanged: 0, unknownHousehold: 0, needsReview: reviewRows.length, nonfinancialExcluded: 0, duplicateSourceRows: 0 },
        validation,
        reviewRows,
        rejectedRows: [],
        paymentAssignments: paymentCandidates,
        results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: 0, rowsRequiringReview: reviewRows.length, rejectedRows: 0, unmatchedJlCodes: 0, elapsedMs: Date.now() - startedAt },
        warnings: ["No changes were made to the database. Correct the source columns or classification details, then retry."],
      });
    }
    if (!matchedActivities.length && !assignmentPlan.pledgeUpdates.length && !alreadyImported) {
      const rollbackCauses = [...new Set(rejectedRows.map((failure) => failure.category))];
      return Response.json({ error: "No donation rows were eligible for import.", fatalError: null, databaseChangesMade: false, noChangesMade: true, rollbackCauses, validation, reviewRows, rejectedRows, paymentAssignments: paymentCandidates, results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: donationPreview.duplicateRows.length, rowsRequiringReview: reviewRows.length, rejectedRows: rejectedRows.length, unmatchedJlCodes: compactPaymentExport ? paymentCandidates.filter((candidate) => !candidate.donorId).length : match.unknownHousehold, elapsedMs: Date.now() - startedAt } }, { status: 422 });
    }
    const now = Math.floor(Date.now() / 1000);
    const importId = crypto.randomUUID();
    const liveHouseholds = await env.DB.prepare("SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live'").bind(userId).all<{ id: string }>();
    const householdsWithGiving = await env.DB.prepare("SELECT DISTINCT donor_id AS id FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND category NOT IN ('needs_review','nonfinancial_entry')").bind(userId).all<{ id: string }>();
    const assignedPledgeDonorIds = assignmentPlan.pledgeUpdates.map((update) => update.donor_id);
    const givingDonorIds = new Set([...householdsWithGiving.results.map((item) => item.id), ...matchedActivities.map((item) => item.donorId), ...assignedPledgeDonorIds]);
    const householdsWithoutGivingHistory = liveHouseholds.results.filter((item) => !givingDonorIds.has(item.id)).length;
    const assignedPaymentCount = assignmentPlan.assignments.filter((assignment) => assignment.decisionType === "apply_to_pledge").length;
    const manuallyAssignedFingerprints = new Set(assignmentPlan.assignments.map((assignment) => assignment.fingerprint));
    const validatedRowNumbers = compactPaymentExport ? paymentCandidates.filter((candidate) => manuallyAssignedFingerprints.has(candidate.fingerprint)).map((candidate) => candidate.row) : match.matched.map((activity) => activity.rowNumber);
    const matchedDonorIds = new Set([...matchedActivities.map((activity) => activity.donorId), ...assignedPledgeDonorIds]);
    const unmatchedJlCodes = compactPaymentExport ? paymentCandidates.filter((candidate) => !candidate.donorId).length : match.unknownHousehold;
    const results = { validRows: compactPaymentExport ? assignmentPlan.assignments.length : matchedActivities.length, householdsMatched: matchedDonorIds.size, newHouseholds: 0, giftsImported: newActivities.length, giftsUpdated: proposedUpdates.length + assignmentPlan.pledgeUpdates.length, duplicateRowsSkipped: donationPreview.duplicateRows.length + alreadyImported, rowsRequiringReview: reviewRows.length, rejectedRows: rejectedRows.length, unmatchedJlCodes, elapsedMs: 0 };
    const report = { importId, fileName, completedAt: new Date(now * 1000).toISOString(), profile: "JL Solutions Donations", databaseChangesMade: true, fatalError: null, mode: prior.results.length || remembered.results.length ? "refresh" : "first", refresh: { kind: "donation", rangeStart: isoDate(exportRange.start), rangeEnd: isoDate(exportRange.end), historicalRecordsDeleted: 0, workspaceRecordsPreserved: true }, firstRelationshipId: matchedActivities[0]?.donorId ?? assignedPledgeDonorIds[0] ?? null, imported: { donors: 0, gifts: newActivities.length, interactions: 0, reminders: 0 }, donation: { newActivities: newActivities.length, updatedPledges: proposedUpdates.length + assignmentPlan.pledgeUpdates.length, unchanged: alreadyImported, unknownHousehold: unmatchedJlCodes, needsReview: reviewRows.length, nonfinancialExcluded: match.nonfinancial, duplicateSourceRows: donationPreview.duplicateRows.length }, paymentAssignments: { appliedToPledges: assignedPaymentCount, newGifts: manualNewActivities.length, overpaymentRemainders: assignmentPlan.newGifts.filter((gift) => gift.kind === "overpayment_remainder").length, rememberedSkipped: assignmentPlan.alreadyApplied.length, pledgeChanges: assignmentPlan.pledgeUpdates.map((update) => ({ pledgeId: update.id, paymentCents: update.paymentCents, previousPaidCents: update.paid_cents, nextPaidCents: update.nextPaidCents, previousBalanceCents: update.balance_cents, nextBalanceCents: update.nextBalanceCents, nextStatus: update.nextCategory })) }, reconciliation: { giftsMatchedByInternalDonorId: compactPaymentExport ? assignmentPlan.assignments.length : matchedActivities.length, unmatchedJlCodes, householdsWithoutGivingHistory, donationRowsRequiringReview: reviewRows.length, todayAndAssistantRefresh: "next_request", userCreatedContentPreserved: true }, results, validation, reviewRows, rejectedRows, warnings: [unmatchedJlCodes && `${unmatchedJlCodes} rows have an unknown JL Code`, reviewRows.length && `${reviewRows.length} rows need review`, donationPreview.duplicateRows.length && `${donationPreview.duplicateRows.length} duplicate source rows were excluded`].filter(Boolean) };
    const changedActivities = [...newActivities, ...proposedUpdates];
    const activityRows = changedActivities.map((activity) => ({ id: crypto.randomUUID(), ownerUserId: userId, donorId: activity.donorId, externalHouseholdId: activity.externalHouseholdId, fingerprint: activity.fingerprint, activityDate: activity.activityDate, committedCents: activity.committedCents, paidCents: activity.paidCents, balanceCents: activity.balanceCents, itemType: activity.itemType, description: activity.description, sourceCampaign: activity.sourceCampaign, category: activity.category, sourceSnapshot: JSON.stringify(activity.sourceValues), now }));
    const priorByFingerprint = new Map(prior.results.map((activity) => [activity.source_fingerprint, activity]));
    const changeRows = [...newActivities.map((activity) => ({ importId, fingerprint: activity.fingerprint, changeType: "insert", previousJson: null, now })), ...proposedUpdates.map((activity) => ({ importId, fingerprint: activity.fingerprint, changeType: "update", previousJson: JSON.stringify(priorByFingerprint.get(activity.fingerprint)), now })), ...assignmentPlan.pledgeUpdates.map((update) => ({ importId, fingerprint: update.source_fingerprint, changeType: "update", previousJson: JSON.stringify({ source_fingerprint: update.source_fingerprint, paid_cents: update.paid_cents, balance_cents: update.balance_cents, category: update.category, source_snapshot: update.source_snapshot }), now }))];
    const activityStatements = chunkJsonRows(activityRows).map((chunk) =>
      env.DB.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, source_campaign, category, record_origin, source_snapshot, created_at, updated_at)
        SELECT json_extract(value,'$.id'), json_extract(value,'$.ownerUserId'), json_extract(value,'$.donorId'), 'JL Solutions', json_extract(value,'$.externalHouseholdId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.activityDate'), json_extract(value,'$.committedCents'), json_extract(value,'$.paidCents'), json_extract(value,'$.balanceCents'), json_extract(value,'$.itemType'), json_extract(value,'$.description'), json_extract(value,'$.sourceCampaign'), json_extract(value,'$.category'), 'live', json_extract(value,'$.sourceSnapshot'), json_extract(value,'$.now'), json_extract(value,'$.now') FROM json_each(?) WHERE true
        ON CONFLICT(owner_user_id, external_source, source_fingerprint) DO UPDATE SET paid_cents=excluded.paid_cents, balance_cents=excluded.balance_cents, category=excluded.category, source_snapshot=excluded.source_snapshot, updated_at=excluded.updated_at`).bind(chunk));
    const changeStatements = chunkJsonRows(changeRows).map((chunk) =>
      env.DB.prepare(`INSERT INTO giving_activity_import_changes (import_id, source_fingerprint, change_type, previous_json, created_at) SELECT json_extract(value,'$.importId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.changeType'), json_extract(value,'$.previousJson'), json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const pledgeUpdateStatements = assignmentPlan.pledgeUpdates.map((update) => env.DB.prepare(`UPDATE giving_activities SET paid_cents = ?, balance_cents = ?, category = ?, source_snapshot = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND donor_id = ? AND balance_cents = ? AND paid_cents = ?`).bind(update.nextPaidCents, update.nextBalanceCents, update.nextCategory, pledgeSnapshotWithPayments(update.source_snapshot, update.paymentFingerprints), now, update.id, userId, update.donor_id, update.balance_cents, update.paid_cents));
    const newGiftDecisionRows = compactPaymentExport ? assignmentPlan.assignments.filter((assignment) => assignment.decisionType === "new_gift").map((assignment) => ({ userId, fingerprint: assignment.fingerprint, decisionType: "new_gift", pledgeId: null, importId, now })) : [];
    const newGiftDecisionStatements = chunkJsonRows(newGiftDecisionRows).map((chunk) => env.DB.prepare(`INSERT INTO jl_payment_assignments (user_id, payment_fingerprint, decision_type, pledge_activity_id, applied_import_id, created_at, updated_at) SELECT json_extract(value,'$.userId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.decisionType'), json_extract(value,'$.pledgeId'), json_extract(value,'$.importId'), json_extract(value,'$.now'), json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const pledgeDecisionStatements = assignmentPlan.pledgeUpdates.flatMap((update) => update.paymentFingerprints.map((fingerprint) => env.DB.prepare(`INSERT INTO jl_payment_assignments (user_id, payment_fingerprint, decision_type, pledge_activity_id, applied_import_id, created_at, updated_at) SELECT CASE WHEN EXISTS (SELECT 1 FROM giving_activities WHERE id = ? AND owner_user_id = ? AND donor_id = ? AND balance_cents = ? AND paid_cents = ?) THEN ? ELSE NULL END, ?, 'apply_to_pledge', ?, ?, ?, ?`).bind(update.id, userId, update.donor_id, update.balance_cents, update.paid_cents, userId, fingerprint, update.id, importId, now, now)));
    const assignmentAuditRows = compactPaymentExport ? assignmentPlan.assignments.map((assignment) => ({ id: crypto.randomUUID(), userId, importId, paymentFingerprint: assignment.fingerprint, donorId: assignment.donorId, pledgeId: assignment.pledgeId, decisionType: assignment.decisionType, paymentCents: assignment.paymentCents, appliedCents: assignment.appliedCents, newGiftCents: assignment.newGiftCents, overpaymentAction: assignment.overpaymentAction, previousPaidCents: assignment.previousPaidCents, nextPaidCents: assignment.nextPaidCents, previousBalanceCents: assignment.previousBalanceCents, nextBalanceCents: assignment.nextBalanceCents, previousStatus: assignment.previousStatus, nextStatus: assignment.nextStatus, now })) : [];
    const assignmentAuditStatements = chunkJsonRows(assignmentAuditRows).map((chunk) => env.DB.prepare(`INSERT INTO jl_payment_assignment_audits
      (id,user_id,import_id,payment_fingerprint,donor_id,pledge_activity_id,decision_type,payment_cents,applied_cents,new_gift_cents,overpayment_action,previous_paid_cents,next_paid_cents,previous_balance_cents,next_balance_cents,previous_status,next_status,created_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.userId'),json_extract(value,'$.importId'),json_extract(value,'$.paymentFingerprint'),json_extract(value,'$.donorId'),json_extract(value,'$.pledgeId'),json_extract(value,'$.decisionType'),json_extract(value,'$.paymentCents'),json_extract(value,'$.appliedCents'),json_extract(value,'$.newGiftCents'),json_extract(value,'$.overpaymentAction'),json_extract(value,'$.previousPaidCents'),json_extract(value,'$.nextPaidCents'),json_extract(value,'$.previousBalanceCents'),json_extract(value,'$.nextBalanceCents'),json_extract(value,'$.previousStatus'),json_extract(value,'$.nextStatus'),json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const statements = [
      env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(userId, user.email, user.displayName, now, now),
      ...activityStatements,
      ...newGiftDecisionStatements,
      ...pledgeDecisionStatements,
      ...pledgeUpdateStatements,
      env.DB.prepare("INSERT INTO data_imports (id, user_id, file_name, file_hash, status, update_existing, report_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', 1, ?, ?, ?)").bind(importId, userId, fileName, fileHash, JSON.stringify(report), now, now),
      ...assignmentAuditStatements,
      env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'live', ?) ON CONFLICT(user_id) DO UPDATE SET data_mode = 'live', updated_at = excluded.updated_at").bind(userId, now),
      env.DB.prepare(`INSERT INTO jl_refresh_state (user_id, last_donation_refresh_at, last_donation_range_start, last_donation_range_end, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET last_donation_refresh_at = excluded.last_donation_refresh_at,
        last_donation_range_start = excluded.last_donation_range_start, last_donation_range_end = excluded.last_donation_range_end, updated_at = excluded.updated_at`)
        .bind(userId, now, exportRange.start, exportRange.end, now),
      ...changeStatements,
    ];
    try {
      await env.DB.batch(statements);
      results.elapsedMs = Date.now() - startedAt;
      logger.info("jl_donation_import_completed", { importId, userId, rows: rows.length, matched: results.validRows, review: reviewRows.length });
      return Response.json(report, { status: 201 });
    } catch (databaseError) {
      const reason = safeDatabaseReason(databaseError);
      const databaseFailure: RowFailure = { row: 0, category: "transaction_database_errors", reason };
      logger.error("jl_donation_import_failed", new Error("Database transaction failed"), { importId, userId, validated: validatedRowNumbers.length });
      const transactionRejectedRows = [...validatedRowNumbers.map((row) => ({ row, category: "transaction_database_errors" as const, reason: "Validated row was not written because the database transaction failed" })), ...rejectedRows];
      return Response.json({ error: reason, fatalError: reason, databaseChangesMade: false, noChangesMade: true, rollbackCauses: ["transaction_database_errors"], validation: { ...validation, firstErrors: [databaseFailure, ...validation.firstErrors].slice(0, 10) }, reviewRows, rejectedRows: transactionRejectedRows, results: { ...results, giftsImported: 0, giftsUpdated: 0, rejectedRows: transactionRejectedRows.length, elapsedMs: Date.now() - startedAt } }, { status: 500 });
    }
    } catch (unexpectedError) {
      logger.error("jl_donation_import_unexpected", new Error("Unexpected import exception"), { userId, rows: rows.length });
      const failure: RowFailure = { row: 0, category: "unexpected_exceptions", reason: "An unexpected exception occurred while preparing the donation import." };
      return Response.json({ error: failure.reason, fatalError: failure.reason, databaseChangesMade: false, noChangesMade: true, rollbackCauses: ["unexpected_exceptions"], validation: { totalRows: rows.length, passedRows: 0, failedRows: rows.length, duplicateRows: 0, nonfinancialRows: 0, firstErrors: [failure] }, rejectedRows: rows.map((_, index) => ({ row: index + 2, category: "unexpected_exceptions" as const, reason: "Row was not written because import preparation failed" })), results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: 0, rowsRequiringReview: rows.length, rejectedRows: rows.length, unmatchedJlCodes: 0, elapsedMs: Date.now() - startedAt } }, { status: 500 });
    }
  }

  const jlDetected = isJlSolutionsExport(Object.keys(rows[0] ?? {}));
  const preview = jlDetected ? buildJlPreview(rows, fileHash) : buildImportPreview(rows, mapping, fileHash);
  if (!preview.donors.length) return Response.json({ error: "No valid donors were found" }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  const importId = crypto.randomUUID();
  const report = {
    importId,
    fileName,
    completedAt: new Date(now * 1000).toISOString(),
    updateExisting: Boolean(body.updateExisting),
    profile: jlDetected ? "JL Solutions" : "General spreadsheet",
    mode: jlDetected ? (body.mode === "refresh" ? "refresh" : "first") : "first",
    refresh: jlDetected ? { kind: "household", historicalRecordsDeleted: 0, workspaceRecordsPreserved: true } : undefined,
    firstRelationshipId: preview.donors[0]?.id ?? null,
    imported: {
      donors: preview.donors.length,
      gifts: preview.gifts.length,
      interactions: preview.interactions.length,
      reminders: preview.reminders.length,
    },
    reconciliation: { giftsMatchedByInternalDonorId: preview.gifts.length, unmatchedJlCodes: 0, householdsWithoutGivingHistory: Math.max(0, preview.donors.length - new Set(preview.gifts.map((gift) => gift.donorId)).size), donationRowsRequiringReview: preview.rejectedRows.length, todayAndAssistantRefresh: "next_request", userCreatedContentPreserved: true },
    rejectedRows: preview.rejectedRows,
    warnings: preview.warnings,
  };

  const ownedIds = new Map(preview.donors.map((donor) => [donor.id, crypto.randomUUID()]));
  const donorRows = preview.donors.map((donor) => ({ ...donor, id: ownedIds.get(donor.id), ownerUserId: userId, now }));
  const giftRows = preview.gifts.map((gift) => ({ ...gift, donorId: ownedIds.get(gift.donorId), now }));
  const interactionRows = preview.interactions.map((interaction) => ({ ...interaction, donorId: ownedIds.get(interaction.donorId), now, userId, source: `import:${importId}` }));
  const reminderRows = preview.reminders.map((reminder) => ({ ...reminder, donorId: ownedIds.get(reminder.donorId), now, userId }));
  const donorSql = body.updateExisting
    ? `INSERT INTO donors (id, owner_user_id, data_source, donor_code, display_name, spouse, email, phone, address, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.ownerUserId'), 'live', json_extract(value, '$.donorCode'), json_extract(value, '$.name'), json_extract(value, '$.spouse'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.address'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?) WHERE true
       ON CONFLICT(owner_user_id, donor_code) DO UPDATE SET display_name = excluded.display_name, spouse = excluded.spouse, email = excluded.email, phone = excluded.phone, address = excluded.address, updated_at = excluded.updated_at`
    : `INSERT OR IGNORE INTO donors (id, owner_user_id, data_source, donor_code, display_name, spouse, email, phone, address, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.ownerUserId'), 'live', json_extract(value, '$.donorCode'), json_extract(value, '$.name'), json_extract(value, '$.spouse'), json_extract(value, '$.email'), json_extract(value, '$.phone'), json_extract(value, '$.address'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`;

  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, user.email, user.displayName, now, now),
  ];

  if (jlDetected) {
    const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
    const existing = codes.length
      ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(codes)).all<ExistingJlDonor>()
      : { results: [] as ExistingJlDonor[] };
    const matches = matchJlDonors(preview.donors, existing.results);
    for (const match of matches) {
      const donor = match.donor;
      const contact = donor.contact!;
      if (!match.existing) {
        const donorId = crypto.randomUUID();
        ownedIds.set(donor.id, donorId);
        statements.push(env.DB.prepare(`INSERT INTO donors (id, owner_user_id, data_source, donor_code, external_source, external_id, display_name, spouse, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot, created_at, updated_at)
          VALUES (?, ?, 'live', ?, 'JL Solutions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(donorId, userId, donor.donorCode, donor.donorCode, donor.name, contact.spouseFirstName, donor.email, donor.phone, donor.address, contact.lastName, contact.primaryFirstName, contact.spouseFirstName, contact.primaryTitle, contact.spouseTitle, contact.alternateMobilePhone, contact.homePhone, contact.addressLine1, contact.city, contact.state, contact.postalCode, contact.country, JSON.stringify(sourceSnapshot(donor)), now, now));
      } else if (body.mode === "refresh") {
        const updates = Object.entries(match.safeUpdates);
        const assignments = updates.map(([field]) => `${field} = ?`);
        assignments.push("source_snapshot = ?", "updated_at = ?");
        ownedIds.set(donor.id, match.existing.id);
        statements.push(env.DB.prepare(`UPDATE donors SET ${assignments.join(", ")} WHERE id = ? AND owner_user_id = ? AND data_source = 'live'`)
          .bind(...updates.map(([, value]) => value), JSON.stringify(sourceSnapshot(donor)), now, match.existing.id, userId));
      }
    }
  } else {
    statements.push(env.DB.prepare(donorSql).bind(JSON.stringify(donorRows)));
  }
  report.firstRelationshipId = ownedIds.get(preview.donors[0]?.id ?? "") ?? report.firstRelationshipId;

  statements.push(
    env.DB.prepare(`INSERT OR IGNORE INTO gifts (id, donor_id, amount_cents, fund, received_at, note, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.donorId'), json_extract(value, '$.amountCents'), json_extract(value, '$.designation'), json_extract(value, '$.date'), json_extract(value, '$.note'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`)
      .bind(JSON.stringify(giftRows)),
    env.DB.prepare(`INSERT OR IGNORE INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.donorId'), json_extract(value, '$.userId'), json_extract(value, '$.type'), json_extract(value, '$.date'), json_extract(value, '$.notes'), json_extract(value, '$.source'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`)
      .bind(JSON.stringify(interactionRows)),
    env.DB.prepare(`INSERT OR IGNORE INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.donorId'), json_extract(value, '$.userId'), json_extract(value, '$.title'), COALESCE(json_extract(value, '$.notes'), 'Imported reminder'), 100, 'open', json_extract(value, '$.dueDate'), json_extract(value, '$.now'), json_extract(value, '$.now') FROM json_each(?)`)
      .bind(JSON.stringify(reminderRows)),
    env.DB.prepare("INSERT INTO data_imports (id, user_id, file_name, file_hash, status, update_existing, report_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)")
      .bind(importId, userId, fileName, fileHash, body.updateExisting ? 1 : 0, JSON.stringify(report), now, now),
    env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'live', ?) ON CONFLICT(user_id) DO UPDATE SET data_mode = 'live', updated_at = excluded.updated_at").bind(userId, now),
  );
  if (jlDetected) statements.push(env.DB.prepare(`INSERT INTO jl_refresh_state (user_id, last_household_refresh_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET last_household_refresh_at = excluded.last_household_refresh_at, updated_at = excluded.updated_at`).bind(userId, now, now));

  try {
    await env.DB.batch(statements);
    logger.info("data_import_completed", { importId, userId, donors: preview.donors.length, rejected: preview.rejectedRows.length });
    return Response.json(report, { status: 201 });
  } catch (error) {
    logger.error("data_import_failed", new Error("Database transaction failed"), { importId, userId });
    return Response.json({ error: "Nothing was imported. Resolve the reported conflict and try again." }, { status: 500 });
  }
}
