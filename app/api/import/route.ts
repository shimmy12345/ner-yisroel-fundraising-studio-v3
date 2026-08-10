import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { buildImportPreview, FIELD_LABELS, type ColumnMapping, type ImportField, type ImportRow } from "../../../lib/import/recognition";
import { buildJlPreview } from "../../../lib/import/jl-solutions";
import { findJlCodeCollisions, findUnresolvableJlCodeOwners, matchJlDonors, sourceSnapshot, type ExistingJlDonor, type JlCodeOwner } from "../../../lib/import/jl-match";
import { logger } from "../../../lib/logger";
import { buildJlDonationPreview, paymentActivitiesForAssignment, stableTransactionId } from "../../../lib/import/jl-donations";
import { matchJlDonationActivities, type ExistingGivingActivity, type MatchedHousehold } from "../../../lib/import/jl-donation-match";
import { classifyJlImportType } from "../../../lib/import/jl-export-type";
import { resolvePossibleDuplicateDecisions, type ReviewDecision } from "../../../lib/import/jl-donation-review";
import { findFingerprintCrossImportMatches, findStableIdCrossImportMatches, resolveCrossImportDecisions, toExistingDonationRecord, type CrossImportDecision, type RawExistingDonationRow } from "../../../lib/import/jl-donation-cross-import";
import { buildRejectedRows, resolveRejectionDecisions, type RejectionDecision } from "../../../lib/import/jl-donation-rejection-review";
import { findInvalidDateDecisions, findStillUnresolvedDateFingerprints, resolveDateDecisions, type DateDecision } from "../../../lib/import/jl-donation-date-review";
import { chunkJsonRows } from "../../../lib/import/d1-json-chunks";
import { isPreviewSessionUsable, reconstructRowsFromChunks, type PreviewSessionRow } from "../../../lib/import/preview-session";
import { resolveAttemptCommitAction, type ImportAttemptRow } from "../../../lib/import/import-attempt";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { donationExportRange, isoDate } from "../../../lib/import/jl-refresh";
import { buildPaymentCandidates, OPEN_PLEDGES_FOR_DONORS_SQL, planPaymentAssignments, type OpenPledge, type PaymentDecisionInput, type RememberedPaymentDecision } from "../../../lib/import/jl-payment-assignment";
import { ACTIVE_PAYMENT_ASSIGNMENTS_SQL, blocksIdenticalImport, canForceReprocessBatch, hasForceReprocessConfirmation } from "../../../lib/import/import-deduplication";
import { findLikelyManualDonorMatches, type ManualDonorMatchRow } from "../../../lib/donors/merge-preview";
import { resolveReviewedJlUpdates, validHouseholdReviewMode, type ExistingDonorDecision, type HouseholdReviewMode } from "../../../lib/import/household-review";
import { CONFIRM_PENDING_GIFT_SQL, pendingGiftMatches, type PendingGiftMatchRow } from "../../../lib/giving/management";

type ImportRequest = {
  fileName?: string;
  fileHash?: string;
  rows?: ImportRow[];
  mapping?: ColumnMapping;
  updateExisting?: boolean;
  mode?: "first" | "refresh";
  paymentDecisions?: PaymentDecisionInput[];
  mergeDecisions?: Array<{ externalId: string; action: "merge" | "keep_separate" | "review_later"; manualDonorId: string }>;
  fieldDecisions?: Array<{ externalId: string; field: string; action: "keep_local" | "use_jl" }>;
  existingDonorDecisions?: ExistingDonorDecision[];
  reviewMode?: HouseholdReviewMode;
  forceReprocess?: boolean;
  forceConfirmation?: string;
  pendingGiftDecisions?: Array<{ fingerprint: string; action: "merge" | "keep_separate"; pendingGiftId?: string | null }>;
  forceType?: "household" | "donation";
  reviewDecisions?: ReviewDecision[];
  crossImportDecisions?: CrossImportDecision[];
  rejectionDecisions?: RejectionDecision[];
  dateDecisions?: DateDecision[];
  previewSessionId?: string;
  attemptId?: string;
};

type ManualDonorRow = ManualDonorMatchRow & {
  address: string | null; last_name: string | null; primary_first_name: string | null; spouse: string | null;
  spouse_first_name: string | null; primary_title: string | null; spouse_title: string | null;
  alternate_mobile_phone: string | null; country: string | null; contact_note: string | null;
};
type FullJlDonorRow = ManualDonorRow & { owner_user_id: string; data_source: string; donor_code: string | null; external_source: string | null; external_id: string | null; source_snapshot: string | null; created_at: number; updated_at: number };
type GeneralExistingDonor = { id: string; donor_code: string; external_source: string | null; display_name: string; spouse: string | null; email: string | null; phone: string | null; address: string | null; last_name: string | null; primary_first_name: string | null; spouse_first_name: string | null; home_phone: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null };

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
  const profile = await ensureUserProfile(user);
  const userId = profile.id;

  let body: ImportRequest;
  try {
    body = await request.json() as ImportRequest;
  } catch {
    return Response.json({ error: "Invalid import request" }, { status: 400 });
  }

  let fileName = body.fileName?.trim() ?? "";
  let fileHash = body.fileHash?.trim().toLowerCase() ?? "";
  let rows: ImportRow[] = Array.isArray(body.rows) ? body.rows : [];
  let mapping: ColumnMapping = body.mapping ?? {};
  let forceType = body.forceType;

  // Prefer the server-stored preview session over a resent file: the client
  // sends only the session id plus decisions, not the full parsed rows.
  const previewSessionId = typeof body.previewSessionId === "string" ? body.previewSessionId.trim() : "";
  if (previewSessionId) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const session = await env.DB.prepare("SELECT id, owner_user_id, file_hash, file_name, mapping_json, force_type, row_count, decisions_json, status, progress_resolved, progress_total, created_at, updated_at, expires_at FROM import_preview_sessions WHERE id = ?").bind(previewSessionId).first<PreviewSessionRow>();
    if (!isPreviewSessionUsable(session, userId, nowSeconds)) {
      return Response.json({ error: "Your review session has expired. Refresh the preview and try again.", sessionExpired: true }, { status: 410 });
    }
    const chunkRows = await env.DB.prepare("SELECT rows_json FROM import_preview_session_chunks WHERE session_id = ? ORDER BY chunk_index").bind(previewSessionId).all<{ rows_json: string }>();
    fileName = session.file_name;
    fileHash = session.file_hash;
    rows = reconstructRowsFromChunks(chunkRows.results.map((row) => row.rows_json));
    forceType = (session.force_type as "household" | "donation" | undefined) ?? forceType;
  }
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
  const pendingDecisionFingerprints = new Set<string>();
  if (body.pendingGiftDecisions !== undefined && (!Array.isArray(body.pendingGiftDecisions) || body.pendingGiftDecisions.some((decision) => {
    const valid = /^[a-f0-9]{64}$/.test(decision?.fingerprint ?? "") && ["merge", "keep_separate"].includes(decision?.action)
      && (decision.action !== "merge" || typeof decision.pendingGiftId === "string" && Boolean(decision.pendingGiftId));
    if (!valid || pendingDecisionFingerprints.has(decision.fingerprint)) return true;
    pendingDecisionFingerprints.add(decision.fingerprint); return false;
  }))) return Response.json({ error: "The pending gift decisions could not be validated" }, { status: 422 });
  const reviewDecisions = body.reviewDecisions ?? [];
  if (!Array.isArray(reviewDecisions) || reviewDecisions.some((decision) => {
    return !(/^[a-f0-9]{64}$/.test(decision?.fingerprint ?? "") && ["import_anyway", "skip", "review_later"].includes(decision?.action)
      && (decision.groupKey === undefined || decision.groupKey === null || /^[a-f0-9]{64}$/.test(decision.groupKey)));
  })) return Response.json({ error: "The review decisions could not be validated" }, { status: 422 });
  const crossImportDecisions = body.crossImportDecisions ?? [];
  if (!Array.isArray(crossImportDecisions) || crossImportDecisions.some((decision) => {
    return !(/^[a-f0-9]{64}$/.test(decision?.fingerprint ?? "") && ["import_anyway", "skip", "review_later"].includes(decision?.action));
  })) return Response.json({ error: "The cross-import duplicate decisions could not be validated" }, { status: 422 });
  const rejectionDecisions = body.rejectionDecisions ?? [];
  if (!Array.isArray(rejectionDecisions) || rejectionDecisions.some((decision) => {
    const valid = /^[a-f0-9]{64}$/.test(decision?.fingerprint ?? "") && ["import_anyway", "match_donor", "skip", "review_later"].includes(decision?.action)
      && (decision.donorId === undefined || typeof decision.donorId === "string" && Boolean(decision.donorId))
      && (decision.correctedJlCode === undefined || typeof decision.correctedJlCode === "string" && Boolean(decision.correctedJlCode.trim()));
    return !valid;
  })) return Response.json({ error: "The rejected row decisions could not be validated" }, { status: 422 });
  const dateDecisions = body.dateDecisions ?? [];
  const invalidDateDecisions = findInvalidDateDecisions(dateDecisions);
  if (invalidDateDecisions.length) {
    // Every invalid entry is reported (not just the first) so a single bad
    // row -- e.g. a native date input that emitted a malformed intermediate
    // value like a 5-digit year -- never masks itself among hundreds of
    // otherwise-valid decisions, and the client can point the user at the
    // exact row instead of failing the whole batch opaquely.
    return Response.json({ error: "The date review decisions could not be validated", invalidDateDecisions }, { status: 422 });
  }
  const mergeDecisionCodes = new Set<string>();
  if (body.mergeDecisions !== undefined && (!Array.isArray(body.mergeDecisions) || body.mergeDecisions.some((decision) => {
    const code = typeof decision?.externalId === "string" ? decision.externalId.trim().toLowerCase() : "";
    const valid = Boolean(code) && ["merge", "keep_separate", "review_later"].includes(decision?.action) && typeof decision?.manualDonorId === "string" && Boolean(decision.manualDonorId);
    if (!valid || mergeDecisionCodes.has(code)) return true;
    mergeDecisionCodes.add(code);
    return false;
  }))) return Response.json({ error: "The donor merge decisions could not be validated" }, { status: 422 });
  const fieldDecisionKeys = new Set<string>();
  if (body.fieldDecisions !== undefined && (!Array.isArray(body.fieldDecisions) || body.fieldDecisions.some((decision) => {
    const code = typeof decision?.externalId === "string" ? decision.externalId.trim().toLowerCase() : "";
    const field = typeof decision?.field === "string" ? decision.field.trim() : "";
    const key = `${code}:${field}`;
    const valid = Boolean(code && field) && ["keep_local", "use_jl"].includes(decision?.action);
    if (!valid || fieldDecisionKeys.has(key)) return true;
    fieldDecisionKeys.add(key);
    return false;
  }))) return Response.json({ error: "The JL field decisions could not be validated" }, { status: 422 });
  const existingDecisionCodes = new Set<string>();
  if (body.existingDonorDecisions !== undefined && (!Array.isArray(body.existingDonorDecisions) || body.existingDonorDecisions.some((decision) => {
    const code = typeof decision?.externalId === "string" ? decision.externalId.trim().toLowerCase() : "";
    const valid = Boolean(code) && ["accept_all", "keep_current", "field_by_field"].includes(decision?.action) && typeof decision?.signature === "string" && Boolean(decision.signature);
    if (!valid || existingDecisionCodes.has(code)) return true;
    existingDecisionCodes.add(code);
    return false;
  }))) return Response.json({ error: "The existing donor review decisions could not be validated" }, { status: 422 });

  const existing = await env.DB.prepare("SELECT id, user_id, status, completed_at FROM data_imports WHERE user_id = ? AND file_hash = ? AND status IN ('active','completed') ORDER BY completed_at DESC, created_at DESC LIMIT 1").bind(userId, fileHash).first<{ id: string; user_id: string; status: string; completed_at: number | null }>();
  const activeDuplicate = existing && blocksIdenticalImport(existing.status) ? existing : null;
  if (activeDuplicate && !body.forceReprocess) {
    return Response.json({
      error: "This identical file belongs to an active completed import and cannot be processed again.",
      importId: activeDuplicate.id,
      duplicateBlocked: true,
      canForceReprocess: canForceReprocessBatch(userId, activeDuplicate.user_id),
      priorStatus: activeDuplicate.status,
      completedAt: activeDuplicate.completed_at,
      warning: "Force reprocess does not bypass row-level or transaction-level duplicate protection.",
    }, { status: 409 });
  }
  if (body.forceReprocess) {
    if (!activeDuplicate || !canForceReprocessBatch(userId, activeDuplicate.user_id)) {
      return Response.json({ error: "Only the authenticated workspace import administrator can force reprocessing." }, { status: 403 });
    }
    if (!hasForceReprocessConfirmation(true, body.forceConfirmation)) {
      return Response.json({ error: "Type FORCE REPROCESS to confirm this protected action." }, { status: 422 });
    }
  }

  const importType = forceType ?? classifyJlImportType(Object.keys(rows[0] ?? {}), rows);
  if (importType === "ambiguous") {
    return Response.json({ error: "This file has some donation-shaped columns but is not clearly one type. Choose whether this is a Household export or a Donation export before importing.", ambiguousType: true }, { status: 422 });
  }

  if (importType === "donation") {
    const startedAt = Date.now();
    const attemptId = typeof body.attemptId === "string" && /^[0-9a-f-]{36}$/i.test(body.attemptId) ? body.attemptId : crypto.randomUUID();

    // Measure, never log donor/financial content: row and decision counts,
    // and the request's own reported byte size, are enough to tell whether
    // a large reviewed import is approaching a Worker limit.
    logger.info("jl_donation_import_commit_received", {
      userId, attemptId, rows: rows.length,
      requestBytes: Number(request.headers.get("content-length") ?? 0),
      reviewDecisions: reviewDecisions.length,
      crossImportDecisions: crossImportDecisions.length,
      rejectionDecisions: rejectionDecisions.length,
      pendingGiftDecisions: (body.pendingGiftDecisions ?? []).length,
      paymentDecisions: paymentDecisions.length,
      usedPreviewSession: Boolean(previewSessionId),
    });

    // Idempotency: an attemptId is issued once per commit click and reused
    // by the client across any lost-response recovery. A completed attempt
    // is replayed (no re-run, no second write); an attempt already in
    // flight is refused rather than processed twice concurrently.
    const existingAttempt = await env.DB.prepare("SELECT id, status, report_json, created_at FROM data_imports WHERE id = ? AND user_id = ?").bind(attemptId, userId).first<ImportAttemptRow>();
    const attemptAction = resolveAttemptCommitAction(existingAttempt);
    if (attemptAction === "replay") {
      logger.info("jl_donation_import_replay", { userId, attemptId });
      return Response.json(JSON.parse(existingAttempt!.report_json));
    }
    if (attemptAction === "reject_in_progress") {
      return Response.json({ error: "This import attempt is already being processed. Check its status before retrying.", attemptId, attemptStatus: "processing" }, { status: 409 });
    }
    const markerNow = Math.floor(Date.now() / 1000);
    if (existingAttempt) {
      await env.DB.prepare("UPDATE data_imports SET status = 'processing', file_name = ?, file_hash = ? WHERE id = ?").bind(fileName, fileHash, attemptId).run();
    } else {
      await env.DB.prepare("INSERT INTO data_imports (id, user_id, file_name, file_hash, status, update_existing, report_json, created_at) VALUES (?, ?, ?, ?, 'processing', 0, '{}', ?)").bind(attemptId, userId, fileName, fileHash, markerNow).run();
    }

    const response = await (async (): Promise<Response> => {
    try {
    const columns = Object.keys(rows[0] ?? {});
    // Date review (lib/import/jl-donation-date-review.ts) is resolved
    // first and rebuilds the preview from the corrected rows: a corrected
    // or accepted date changes the row's own content, and every normal
    // rule (duplicate grouping, household matching, amount checks) must
    // apply to that corrected content, not the original invalid/suspicious
    // one. The original source column is never touched -- corrections are
    // carried as a separate annotation (see classifyJlDonation) so
    // source_snapshot always keeps the original value too.
    const initialDonationPreview = await buildJlDonationPreview(rows);
    const dateResolution = resolveDateDecisions(rows, initialDonationPreview.activities, dateDecisions);
    if (dateResolution.unresolvedFingerprints.length) {
      return Response.json({ error: "Review every flagged date before importing.", unresolvedDateFingerprints: dateResolution.unresolvedFingerprints }, { status: 422 });
    }
    const donationPreview = dateResolution.appliedRowNumbers.size ? await buildJlDonationPreview(dateResolution.rows) : initialDonationPreview;
    const stillUnresolvedDateFingerprints = findStillUnresolvedDateFingerprints(dateResolution.appliedRowNumbers, donationPreview.activities);
    if (stillUnresolvedDateFingerprints.length) {
      return Response.json({ error: "A corrected date still needs review before importing.", unresolvedDateFingerprints: stillUnresolvedDateFingerprints }, { status: 422 });
    }
    const dateEditByFingerprint = new Map(dateResolution.edits.map((edit) => [edit.row, edit]));
    const dateAuditByFingerprint = new Map(donationPreview.activities.filter((activity) => dateEditByFingerprint.has(activity.rowNumber)).map((activity) => {
      const edit = dateEditByFingerprint.get(activity.rowNumber)!;
      return [activity.fingerprint, JSON.stringify({ correction: true, field: edit.field, originalValue: edit.originalValue, correctedValue: edit.correctedValue })];
    }));
    const reviewResolution = resolvePossibleDuplicateDecisions(donationPreview.activities, reviewDecisions);
    if (reviewResolution.unresolvedFingerprints.length) {
      return Response.json({ error: "Review every possible-duplicate row before importing.", unresolvedReviewFingerprints: reviewResolution.unresolvedFingerprints }, { status: 422 });
    }
    const approvedByFingerprint = new Map(reviewResolution.approvedActivities.map((activity) => [activity.fingerprint, activity]));
    donationPreview.activities = donationPreview.activities.map((activity) => approvedByFingerprint.get(activity.fingerprint) ?? activity);
    // A row with an unresolved date problem stays in the general review
    // queue instead of being swept into payment assignment, which has no
    // way to correct a date -- one queue, one place to resolve it.
    const paymentActivities = paymentActivitiesForAssignment(donationPreview.activities.filter((activity) => activity.dateIssue === null), columns);
    const paymentFingerprints = new Set(paymentActivities.map((activity) => activity.fingerprint));
    const standardPreview = { ...donationPreview, activities: donationPreview.activities.filter((activity) => !paymentFingerprints.has(activity.fingerprint)) };
    const codes = [...new Set(donationPreview.activities.map((activity) => activity.externalHouseholdId.toLowerCase()).filter(Boolean))];
    const fingerprints = donationPreview.activities.map((activity) => activity.fingerprint);
    const households = codes.length ? await env.DB.prepare(`SELECT id, external_id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(codes)).all<MatchedHousehold & { display_name: string }>() : { results: [] as Array<MatchedHousehold & { display_name: string }> };
    const prior = fingerprints.length ? await env.DB.prepare(`SELECT id, donor_id, activity_date, committed_cents, source_campaign, source_fingerprint, paid_cents, balance_cents, category, source_snapshot, created_at FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(fingerprints)).all<ExistingGivingActivity & RawExistingDonationRow>() : { results: [] as Array<ExistingGivingActivity & RawExistingDonationRow> };
    const match = matchJlDonationActivities(standardPreview, households.results, prior.results);
    // Cross-import duplicate protection (lib/import/jl-donation-cross-import.ts):
    // a stable transaction ID already used in a prior import is a confirmed
    // duplicate; a matching content fingerprint with unchanged payment
    // fields (what would otherwise silently count as "already imported") is
    // a possible duplicate. Both default to Skip unless the user explicitly
    // chooses "Import anyway" for that row.
    const existingByFingerprintRecord = new Map(prior.results.map((record) => [record.source_fingerprint, toExistingDonationRecord(record)]));
    const proposedUpdateFingerprints = new Set(match.proposedUpdates.map((activity) => activity.fingerprint));
    const unchangedExistingActivities = match.matched.filter((activity) => existingByFingerprintRecord.has(activity.fingerprint) && !proposedUpdateFingerprints.has(activity.fingerprint));
    const hasStableIds = donationPreview.activities.some((activity) => stableTransactionId(activity.sourceValues) !== null);
    const broadExisting = hasStableIds
      ? await env.DB.prepare(`SELECT id, donor_id, activity_date, committed_cents, source_campaign, source_snapshot, created_at FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions'`).bind(userId).all<RawExistingDonationRow>()
      : { results: [] as RawExistingDonationRow[] };
    const stableIdMatches = findStableIdCrossImportMatches(match.newActivities, broadExisting.results.map(toExistingDonationRecord));
    const crossImportMatches = [...stableIdMatches, ...findFingerprintCrossImportMatches(unchangedExistingActivities, existingByFingerprintRecord, new Set(stableIdMatches.map((item) => item.fingerprint)))];
    const crossImportActivityByFingerprint = new Map([...match.newActivities, ...unchangedExistingActivities].map((activity) => [activity.fingerprint, activity]));
    const crossImportResolution = await resolveCrossImportDecisions(crossImportActivityByFingerprint, crossImportMatches, crossImportDecisions, crypto.randomUUID());
    const crossImportExcludeSet = new Set(crossImportResolution.excludeFingerprints);
    // A confirmed duplicate approved via "Import anyway" keeps its original
    // fingerprint; a possible duplicate approved that way gets a new
    // override fingerprint. Key the audit note by whichever fingerprint the
    // inserted row will actually carry.
    const crossImportAuditByFingerprint = new Map<string, string>();
    for (const outcome of crossImportResolution.outcomes) {
      if (outcome.matchType === "confirmed_duplicate" && outcome.auditPreviousJson) crossImportAuditByFingerprint.set(outcome.fingerprint, outcome.auditPreviousJson);
    }
    for (const addition of crossImportResolution.approvedAdditions) crossImportAuditByFingerprint.set(addition.activity.fingerprint, addition.auditPreviousJson);
    // Rejected-row review (lib/import/jl-donation-rejection-review.ts): an
    // unmatched JL Code can be resolved by matching (or correcting to) a
    // known household; a nonfinancial entry can be imported on purpose.
    // Neither is offered "Import anyway" without first resolving to a real
    // donor -- an unresolved reviewable row blocks commit rather than being
    // silently dropped or guessed.
    const householdByCode = new Map(households.results.map((household) => [household.external_id.toLowerCase(), household.id]));
    const correctedCodes = [...new Set(rejectionDecisions.map((decision) => decision.correctedJlCode?.trim().toLowerCase()).filter((code): code is string => Boolean(code)).filter((code) => !householdByCode.has(code)))];
    const correctedHouseholds = correctedCodes.length
      ? await env.DB.prepare(`SELECT id, external_id FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(correctedCodes)).all<{ id: string; external_id: string }>()
      : { results: [] as Array<{ id: string; external_id: string }> };
    for (const household of correctedHouseholds.results) householdByCode.set(household.external_id.toLowerCase(), household.id);
    const rejectionResolution = resolveRejectionDecisions(match.unknownActivities, match.nonfinancialActivities, rejectionDecisions, householdByCode);
    if (rejectionResolution.unresolvedFingerprints.length) {
      return Response.json({ error: "Review every rejected row before importing.", unresolvedRejectionFingerprints: rejectionResolution.unresolvedFingerprints }, { status: 422 });
    }
    const rejectionApprovedFingerprints = new Set(rejectionResolution.approvedActivities.map((activity) => activity.fingerprint));
    const rejectionAuditByFingerprint = new Map(rejectionResolution.edits.map((edit) => [edit.fingerprint, JSON.stringify({ correction: true, field: edit.field, originalValue: edit.originalValue, correctedValue: edit.correctedValue })]));
    const donorIds = households.results.map((household) => household.id);
    const openPledges = donorIds.length
      ? await env.DB.prepare(OPEN_PLEDGES_FOR_DONORS_SQL).bind(userId, JSON.stringify(donorIds)).all<OpenPledge>()
      : { results: [] as OpenPledge[] };
    const paymentFingerprintsList = paymentActivities.map((activity) => activity.fingerprint);
    const remembered = paymentFingerprintsList.length
      ? await env.DB.prepare(ACTIVE_PAYMENT_ASSIGNMENTS_SQL).bind(userId, JSON.stringify(paymentFingerprintsList)).all<RememberedPaymentDecision>()
      : { results: [] as RememberedPaymentDecision[] };
    const rememberedFingerprints = new Set(remembered.results.map((decision) => decision.payment_fingerprint));
    const rememberedWithLegacyGifts = [...remembered.results, ...prior.results.filter((activity) => !rememberedFingerprints.has(activity.source_fingerprint)).map((activity) => ({ payment_fingerprint: activity.source_fingerprint, decision_type: "new_gift" as const, pledge_activity_id: null, applied_import_id: "existing-gift" }))];
    const paymentCandidates = buildPaymentCandidates(paymentActivities, households.results, openPledges.results, rememberedWithLegacyGifts);
    const assignmentPlan = planPaymentAssignments(paymentCandidates, paymentDecisions);
    const candidateByFingerprint = new Map(paymentCandidates.map((candidate) => [candidate.fingerprint, candidate]));
    const activityByFingerprint = new Map(donationPreview.activities.map((activity) => [activity.fingerprint, activity]));
    const manualNewActivities = assignmentPlan.newGifts.map((gift) => {
      const activity = activityByFingerprint.get(gift.sourceFingerprint)!;
      const candidate = candidateByFingerprint.get(gift.sourceFingerprint)!;
      return { ...activity, fingerprint: gift.fingerprint, donorId: candidate.donorId!, committedCents: gift.amountCents, paidCents: gift.amountCents, balanceCents: 0, category: "completed_gift" as const, reviewReason: null, sourceValues: { ...activity.sourceValues, fundraisingOsPaymentFingerprint: gift.sourceFingerprint, fundraisingOsAllocation: gift.kind } };
    });
    const matchedActivities = [...match.matched, ...manualNewActivities, ...rejectionResolution.approvedActivities];
    const newActivities = [
      ...match.newActivities.filter((activity) => !crossImportExcludeSet.has(activity.fingerprint)),
      ...manualNewActivities,
      ...crossImportResolution.approvedAdditions.map((entry) => entry.activity),
      ...rejectionResolution.approvedActivities,
    ];
    const proposedUpdates = match.proposedUpdates;
    const alreadyImported = match.alreadyImported + assignmentPlan.alreadyApplied.length;
    const pendingKey = (activity: typeof newActivities[number]) => activity.sourceValues.fundraisingOsPaymentFingerprint || activity.fingerprint;
    const pendingInputs = newActivities
      .filter((activity) => activity.sourceValues.fundraisingOsAllocation !== "overpayment_remainder")
      .map((activity) => ({ fingerprint: pendingKey(activity), donorId: activity.donorId, activityDate: activity.activityDate, committedCents: activity.committedCents }));
    const pendingDonorIds = [...new Set(pendingInputs.map((item) => item.donorId))];
    const pending = pendingDonorIds.length ? await env.DB.prepare(`SELECT id,donor_id,activity_date,committed_cents,description,private_note,workspace_status,category,confirmed_by_activity_id FROM giving_activities WHERE owner_user_id=? AND record_origin='live' AND category='pending_gift' AND workspace_status='active' AND confirmed_by_activity_id IS NULL AND donor_id IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(pendingDonorIds)).all<PendingGiftMatchRow>() : { results: [] as PendingGiftMatchRow[] };
    const pendingMatches = pendingGiftMatches(pendingInputs, pending.results);
    const pendingDecisionByFingerprint = new Map((body.pendingGiftDecisions ?? []).map((decision) => [decision.fingerprint, decision]));
    const claimedPendingIds = new Set<string>();
    for (const candidateMatch of pendingMatches) {
      const decision = pendingDecisionByFingerprint.get(candidateMatch.fingerprint);
      if (!decision) return Response.json({ error: "Review every suggested pending gift match before importing." }, { status: 422 });
      if (decision.action === "merge") {
        if (!decision.pendingGiftId || !candidateMatch.candidates.some((candidate) => candidate.id === decision.pendingGiftId)) return Response.json({ error: "The selected pending gift no longer matches this JL record. Refresh the preview." }, { status: 409 });
        if (claimedPendingIds.has(decision.pendingGiftId)) return Response.json({ error: "One pending gift cannot be matched to multiple JL records." }, { status: 422 });
        claimedPendingIds.add(decision.pendingGiftId);
      }
    }
    const exportRange = donationExportRange([...match.matched, ...paymentActivities]);
    const reviewRows: RowFailure[] = [
      ...assignmentPlan.errors.map((error) => ({ ...error, category: reviewCategory(error.reason) })),
      ...match.reviewActivities.map((activity) => ({ row: activity.rowNumber, category: reviewCategory(activity.reviewReason), reason: activity.reviewReason ?? "Row requires review" })),
    ]
      .sort((a, b) => a.row - b.row);
    const rejectedRows: RowFailure[] = [
      ...donationPreview.duplicateRows.map((duplicate) => ({ row: duplicate.row, category: "duplicate_records" as const, reason: "Duplicate source row" })),
      ...match.unknownActivities.filter((activity) => !rejectionApprovedFingerprints.has(activity.fingerprint)).map((activity) => ({ row: activity.rowNumber, category: "unmatched_jl_codes" as const, reason: "JL Code does not match an imported household" })),
      ...match.nonfinancialActivities.filter((activity) => !rejectionApprovedFingerprints.has(activity.fingerprint)).map((activity) => ({ row: activity.rowNumber, category: "nonfinancial_entries" as const, reason: "Zero-dollar, complimentary, or included entry was excluded from giving history" })),
    ].sort((a, b) => a.row - b.row);
    const validationIssues = [...reviewRows, ...rejectedRows].sort((a, b) => a.row - b.row);
    const validation = { totalRows: rows.length, passedRows: match.matched.length + rejectionResolution.approvedActivities.length + assignmentPlan.assignments.length, failedRows: reviewRows.length + rejectedRows.length, duplicateRows: donationPreview.duplicateRows.length + alreadyImported, nonfinancialRows: match.nonfinancial - match.nonfinancialActivities.filter((activity) => rejectionApprovedFingerprints.has(activity.fingerprint)).length, firstErrors: validationIssues.slice(0, 10) };
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
      return Response.json({ error: "No donation rows were eligible for import.", fatalError: null, databaseChangesMade: false, noChangesMade: true, rollbackCauses, validation, reviewRows, rejectedRows, paymentAssignments: paymentCandidates, results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: donationPreview.duplicateRows.length, rowsRequiringReview: reviewRows.length, rejectedRows: rejectedRows.length, unmatchedJlCodes: match.unknownHousehold + paymentCandidates.filter((candidate) => !candidate.donorId).length, elapsedMs: Date.now() - startedAt } }, { status: 422 });
    }
    if (body.forceReprocess && !newActivities.length && !proposedUpdates.length && !assignmentPlan.pledgeUpdates.length) {
      return Response.json({
        importId: activeDuplicate!.id,
        fileName,
        completedAt: new Date().toISOString(),
        profile: "JL Solutions Donations",
        mode: "refresh",
        databaseChangesMade: false,
        noChangesMade: true,
        imported: { donors: 0, gifts: 0, interactions: 0, reminders: 0 },
        donation: { newActivities: 0, updatedPledges: 0, unchanged: alreadyImported, unknownHousehold: 0, needsReview: reviewRows.length, nonfinancialExcluded: match.nonfinancial, duplicateSourceRows: donationPreview.duplicateRows.length },
        validation,
        reviewRows,
        rejectedRows,
        results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: alreadyImported + donationPreview.duplicateRows.length, rowsRequiringReview: reviewRows.length, rejectedRows: rejectedRows.length, unmatchedJlCodes: 0, elapsedMs: Date.now() - startedAt },
        warnings: ["Force reprocess completed row-level duplicate checks. Every payment was already active, so no database changes were made."],
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const importId = attemptId;
    const liveHouseholds = await env.DB.prepare("SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL").bind(userId).all<{ id: string }>();
    const householdsWithGiving = await env.DB.prepare("SELECT DISTINCT donor_id AS id FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift')").bind(userId).all<{ id: string }>();
    const assignedPledgeDonorIds = assignmentPlan.pledgeUpdates.map((update) => update.donor_id);
    const givingDonorIds = new Set([...householdsWithGiving.results.map((item) => item.id), ...matchedActivities.map((item) => item.donorId), ...assignedPledgeDonorIds]);
    const householdsWithoutGivingHistory = liveHouseholds.results.filter((item) => !givingDonorIds.has(item.id)).length;
    const assignedPaymentCount = assignmentPlan.assignments.filter((assignment) => assignment.decisionType === "apply_to_pledge").length;
    const manuallyAssignedFingerprints = new Set(assignmentPlan.assignments.map((assignment) => assignment.fingerprint));
    const validatedRowNumbers = [...match.matched.map((activity) => activity.rowNumber), ...rejectionResolution.approvedActivities.map((activity) => activity.rowNumber), ...paymentCandidates.filter((candidate) => manuallyAssignedFingerprints.has(candidate.fingerprint)).map((candidate) => candidate.row)];
    const matchedDonorIds = new Set([...matchedActivities.map((activity) => activity.donorId), ...assignedPledgeDonorIds]);
    // Resolved-via-decision unmatched/nonfinancial rows are now imported,
    // not still rejected -- final totals must reflect only what actually
    // ends up excluded.
    const resolvedUnmatchedCount = match.unknownActivities.filter((activity) => rejectionApprovedFingerprints.has(activity.fingerprint)).length;
    const resolvedNonfinancialCount = match.nonfinancialActivities.filter((activity) => rejectionApprovedFingerprints.has(activity.fingerprint)).length;
    const unmatchedJlCodes = match.unknownHousehold - resolvedUnmatchedCount + paymentCandidates.filter((candidate) => !candidate.donorId).length;
    const nonfinancialExcluded = match.nonfinancial - resolvedNonfinancialCount;
    const results = { validRows: match.matched.length + rejectionResolution.approvedActivities.length + assignmentPlan.assignments.length, householdsMatched: matchedDonorIds.size, newHouseholds: 0, giftsImported: newActivities.length, giftsUpdated: proposedUpdates.length + assignmentPlan.pledgeUpdates.length, duplicateRowsSkipped: donationPreview.duplicateRows.length + alreadyImported, rowsRequiringReview: reviewRows.length, rejectedRows: rejectedRows.length, unmatchedJlCodes, elapsedMs: 0 };
    const report = { importId, fileName, completedAt: new Date(now * 1000).toISOString(), profile: "JL Solutions Donations", databaseChangesMade: true, fatalError: null, mode: prior.results.length || remembered.results.length ? "refresh" : "first", refresh: { kind: "donation", rangeStart: isoDate(exportRange.start), rangeEnd: isoDate(exportRange.end), historicalRecordsDeleted: 0, workspaceRecordsPreserved: true }, firstRelationshipId: matchedActivities[0]?.donorId ?? assignedPledgeDonorIds[0] ?? null, imported: { donors: 0, gifts: newActivities.length, interactions: 0, reminders: 0 }, donation: { newActivities: newActivities.length, updatedPledges: proposedUpdates.length + assignmentPlan.pledgeUpdates.length, unchanged: alreadyImported, unknownHousehold: unmatchedJlCodes, needsReview: reviewRows.length, nonfinancialExcluded, duplicateSourceRows: donationPreview.duplicateRows.length, pendingGiftsConfirmed: claimedPendingIds.size, crossImportDuplicatesSkipped: crossImportResolution.outcomes.filter((outcome) => outcome.action === "skipped").length, crossImportDuplicatesImportedAnyway: crossImportResolution.outcomes.filter((outcome) => outcome.action === "imported").length }, crossImportRows: crossImportResolution.outcomes.map((outcome) => ({ fingerprint: outcome.fingerprint, matchType: outcome.matchType, action: outcome.action, existingActivityId: outcome.existing.activityId, existingDonorId: outcome.existing.donorId, existingActivityDate: outcome.existing.activityDate, existingAmountCents: outcome.existing.committedCents, existingCampaign: outcome.existing.sourceCampaign, existingImportedAt: outcome.existing.importedAt })), paymentAssignments: { appliedToPledges: assignedPaymentCount, newGifts: manualNewActivities.length, overpaymentRemainders: assignmentPlan.newGifts.filter((gift) => gift.kind === "overpayment_remainder").length, rememberedSkipped: assignmentPlan.alreadyApplied.length, pledgeChanges: assignmentPlan.pledgeUpdates.map((update) => ({ pledgeId: update.id, paymentCents: update.paymentCents, previousPaidCents: update.paid_cents, nextPaidCents: update.nextPaidCents, previousBalanceCents: update.balance_cents, nextBalanceCents: update.nextBalanceCents, nextStatus: update.nextCategory })) }, reconciliation: { giftsMatchedByInternalDonorId: match.matched.length + rejectionResolution.approvedActivities.length + assignmentPlan.assignments.length, unmatchedJlCodes, householdsWithoutGivingHistory, donationRowsRequiringReview: reviewRows.length, todayAndAssistantRefresh: "next_request", userCreatedContentPreserved: true }, results, validation, reviewRows, rejectedRows, rejectedRowDetails: buildRejectedRows(donationPreview.duplicateRows, match.unknownActivities, match.nonfinancialActivities).map((item) => ({ ...item, outcome: item.severity === "hard" ? "hard_excluded" as const : rejectionApprovedFingerprints.has(item.fingerprint) ? "imported" as const : "skipped" as const })), warnings: [unmatchedJlCodes && `${unmatchedJlCodes} rows have an unknown JL Code`, reviewRows.length && `${reviewRows.length} rows need review`, donationPreview.duplicateRows.length && `${donationPreview.duplicateRows.length} duplicate source rows were excluded`].filter(Boolean) };
    const changedActivities = [...newActivities, ...proposedUpdates];
    const activityRows = changedActivities.map((activity) => ({ id: crypto.randomUUID(), ownerUserId: userId, donorId: activity.donorId, externalHouseholdId: activity.externalHouseholdId, fingerprint: activity.fingerprint, decisionFingerprint: pendingKey(activity), activityDate: activity.activityDate, committedCents: activity.committedCents, paidCents: activity.paidCents, balanceCents: activity.balanceCents, itemType: activity.itemType, description: activity.description, sourceCampaign: activity.sourceCampaign, category: activity.category, sourceSnapshot: JSON.stringify(activity.sourceValues), now }));
    const activityIdByDecisionFingerprint = new Map(activityRows.map((row) => [row.decisionFingerprint, row.id]));
    const pendingMergeStatements = pendingMatches.flatMap((candidateMatch) => {
      const decision = pendingDecisionByFingerprint.get(candidateMatch.fingerprint);
      if (decision?.action !== "merge" || !decision.pendingGiftId) return [];
      const importedActivityId = activityIdByDecisionFingerprint.get(candidateMatch.fingerprint)!;
      const candidate = candidateMatch.candidates.find((item) => item.id === decision.pendingGiftId)!;
      return [
        env.DB.prepare(CONFIRM_PENDING_GIFT_SQL).bind(importedActivityId, now, candidate.id, userId, candidate.donor_id),
        env.DB.prepare(`INSERT INTO giving_activity_management_audits (id,user_id,activity_id,import_id,action,previous_donor_id,next_donor_id,previous_status,next_status,previous_note,next_note,created_at) VALUES (?,?,?,?,'pending_matched',?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), userId, candidate.id, importId, candidate.donor_id, candidate.donor_id, candidate.workspace_status, "merged", candidate.private_note, candidate.private_note, now),
      ];
    });
    const priorByFingerprint = new Map(prior.results.map((activity) => [activity.source_fingerprint, activity]));
    const changeRows = [...newActivities.map((activity) => ({ importId, fingerprint: activity.fingerprint, changeType: "insert", previousJson: crossImportAuditByFingerprint.get(activity.fingerprint) ?? rejectionAuditByFingerprint.get(activity.fingerprint) ?? dateAuditByFingerprint.get(activity.fingerprint) ?? null, now })), ...proposedUpdates.map((activity) => ({ importId, fingerprint: activity.fingerprint, changeType: "update", previousJson: JSON.stringify(priorByFingerprint.get(activity.fingerprint)), now })), ...assignmentPlan.pledgeUpdates.map((update) => ({ importId, fingerprint: update.source_fingerprint, changeType: "update", previousJson: JSON.stringify({ source_fingerprint: update.source_fingerprint, paid_cents: update.paid_cents, balance_cents: update.balance_cents, category: update.category, source_snapshot: update.source_snapshot }), now }))];
    const activityStatements = chunkJsonRows(activityRows).map((chunk) =>
      env.DB.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, source_campaign, category, record_origin, source_snapshot, created_at, updated_at)
        SELECT json_extract(value,'$.id'), json_extract(value,'$.ownerUserId'), json_extract(value,'$.donorId'), 'JL Solutions', json_extract(value,'$.externalHouseholdId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.activityDate'), json_extract(value,'$.committedCents'), json_extract(value,'$.paidCents'), json_extract(value,'$.balanceCents'), json_extract(value,'$.itemType'), json_extract(value,'$.description'), json_extract(value,'$.sourceCampaign'), json_extract(value,'$.category'), 'live', json_extract(value,'$.sourceSnapshot'), json_extract(value,'$.now'), json_extract(value,'$.now') FROM json_each(?) WHERE true
        ON CONFLICT(owner_user_id, external_source, source_fingerprint) DO UPDATE SET paid_cents=excluded.paid_cents, balance_cents=excluded.balance_cents, category=excluded.category, source_snapshot=excluded.source_snapshot, updated_at=excluded.updated_at`).bind(chunk));
    const changeStatements = chunkJsonRows(changeRows).map((chunk) =>
      env.DB.prepare(`INSERT INTO giving_activity_import_changes (import_id, source_fingerprint, change_type, previous_json, created_at) SELECT json_extract(value,'$.importId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.changeType'), json_extract(value,'$.previousJson'), json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const pledgeUpdateStatements = assignmentPlan.pledgeUpdates.map((update) => env.DB.prepare(`UPDATE giving_activities SET paid_cents = ?, balance_cents = ?, category = ?, source_snapshot = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND donor_id = ? AND workspace_status = 'active' AND balance_cents = ? AND paid_cents = ?`).bind(update.nextPaidCents, update.nextBalanceCents, update.nextCategory, pledgeSnapshotWithPayments(update.source_snapshot, update.paymentFingerprints), now, update.id, userId, update.donor_id, update.balance_cents, update.paid_cents));
    const newGiftDecisionRows = assignmentPlan.assignments.filter((assignment) => assignment.decisionType === "new_gift").map((assignment) => ({ userId, fingerprint: assignment.fingerprint, decisionType: "new_gift", pledgeId: null, importId, now }));
    const newGiftDecisionStatements = chunkJsonRows(newGiftDecisionRows).map((chunk) => env.DB.prepare(`INSERT INTO jl_payment_assignments (user_id, payment_fingerprint, decision_type, pledge_activity_id, applied_import_id, created_at, updated_at) SELECT json_extract(value,'$.userId'), json_extract(value,'$.fingerprint'), json_extract(value,'$.decisionType'), json_extract(value,'$.pledgeId'), json_extract(value,'$.importId'), json_extract(value,'$.now'), json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const pledgeDecisionStatements = assignmentPlan.pledgeUpdates.flatMap((update) => update.paymentFingerprints.map((fingerprint) => env.DB.prepare(`INSERT INTO jl_payment_assignments (user_id, payment_fingerprint, decision_type, pledge_activity_id, applied_import_id, created_at, updated_at) SELECT CASE WHEN EXISTS (SELECT 1 FROM giving_activities WHERE id = ? AND owner_user_id = ? AND donor_id = ? AND workspace_status = 'active' AND balance_cents = ? AND paid_cents = ?) THEN ? ELSE NULL END, ?, 'apply_to_pledge', ?, ?, ?, ?`).bind(update.id, userId, update.donor_id, update.balance_cents, update.paid_cents, userId, fingerprint, update.id, importId, now, now)));
    const assignmentAuditRows = assignmentPlan.assignments.map((assignment) => ({ id: crypto.randomUUID(), userId, importId, paymentFingerprint: assignment.fingerprint, donorId: assignment.donorId, pledgeId: assignment.pledgeId, decisionType: assignment.decisionType, paymentCents: assignment.paymentCents, appliedCents: assignment.appliedCents, newGiftCents: assignment.newGiftCents, overpaymentAction: assignment.overpaymentAction, previousPaidCents: assignment.previousPaidCents, nextPaidCents: assignment.nextPaidCents, previousBalanceCents: assignment.previousBalanceCents, nextBalanceCents: assignment.nextBalanceCents, previousStatus: assignment.previousStatus, nextStatus: assignment.nextStatus, paymentDate: candidateByFingerprint.get(assignment.fingerprint)?.paymentDate ?? now, remainingBalanceCents: assignment.nextBalanceCents, now }));
    const assignmentAuditStatements = chunkJsonRows(assignmentAuditRows).map((chunk) => env.DB.prepare(`INSERT INTO jl_payment_assignment_audits
      (id,user_id,import_id,payment_fingerprint,donor_id,pledge_activity_id,decision_type,payment_cents,applied_cents,new_gift_cents,overpayment_action,previous_paid_cents,next_paid_cents,previous_balance_cents,next_balance_cents,previous_status,next_status,payment_date,remaining_balance_cents,created_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.userId'),json_extract(value,'$.importId'),json_extract(value,'$.paymentFingerprint'),json_extract(value,'$.donorId'),json_extract(value,'$.pledgeId'),json_extract(value,'$.decisionType'),json_extract(value,'$.paymentCents'),json_extract(value,'$.appliedCents'),json_extract(value,'$.newGiftCents'),json_extract(value,'$.overpaymentAction'),json_extract(value,'$.previousPaidCents'),json_extract(value,'$.nextPaidCents'),json_extract(value,'$.previousBalanceCents'),json_extract(value,'$.nextBalanceCents'),json_extract(value,'$.previousStatus'),json_extract(value,'$.nextStatus'),json_extract(value,'$.paymentDate'),json_extract(value,'$.remainingBalanceCents'),json_extract(value,'$.now') FROM json_each(?)`).bind(chunk));
    const statements = [
      env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(userId, user.email, user.displayName, now, now),
      ...activityStatements,
      ...newGiftDecisionStatements,
      ...pledgeDecisionStatements,
      ...pledgeUpdateStatements,
      ...pendingMergeStatements,
      // UPDATE, not INSERT: the row for this attemptId was already created
      // (status='processing') before this heavy work began, so a lost
      // response can still be reconciled by attemptId. Marking it
      // 'completed' atomically with the financial writes below means the
      // status endpoint never reports "committed" before it actually is.
      env.DB.prepare("UPDATE data_imports SET file_name = ?, file_hash = ?, status = 'completed', update_existing = 1, report_json = ?, completed_at = ? WHERE id = ?").bind(fileName, fileHash, JSON.stringify(report), now, importId),
      // Close the review draft on success, atomically with the financial
      // write, so it can never later be resumed or reused for a different
      // import of the same file.
      ...(previewSessionId ? [env.DB.prepare("UPDATE import_preview_sessions SET status = 'committed', updated_at = ? WHERE id = ?").bind(now, previewSessionId)] : []),
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
    })();

    // Best-effort finalize: the success path below already updates this row
    // to 'completed' atomically together with the financial writes, in the
    // same batch, so this is a no-op there. Every other exit (a validation
    // rejection, or a caught database/unexpected error) never touched that
    // row at all, so this is what actually clears it out of 'processing' --
    // the step that makes the status endpoint trustworthy even when this
    // response itself never reaches the browser.
    try {
      const responseBody = await response.clone().json();
      await env.DB.prepare("UPDATE data_imports SET status = ?, report_json = ?, completed_at = ? WHERE id = ? AND status != 'completed'").bind(response.ok ? "completed" : "failed", JSON.stringify(responseBody), Math.floor(Date.now() / 1000), attemptId).run();
    } catch (finalizeError) {
      logger.error("jl_donation_import_attempt_finalize_failed", finalizeError, { userId, attemptId });
    }
    return response;
  }

  const jlDetected = importType === "household";
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
    refresh: { kind: "household" as const, historicalRecordsDeleted: 0, workspaceRecordsPreserved: true },
    household: { created: 0, updated: 0, merged: 0, reviewLater: 0, previousRefreshAt: null as number | null, reviewMode: profile.importReviewMode, decisions: [] as Array<{ externalId: string; action: string; fields: Record<string, string> }>, duplicateDecisions: [] as Array<{ externalId: string; action: string; manualDonorId: string }> },
    firstRelationshipId: (preview.donors[0]?.id ?? null) as string | null,
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

  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, user.email, user.displayName, now, now),
  ];
  const householdChangeRows: Array<{ id: string; importId: string; userId: string; donorId: string; changeType: "insert" | "update" | "merge" | "consolidated"; beforeJson: string | null; afterJson: string; now: number }> = [];

  if (jlDetected) {
    const priorRefresh = await env.DB.prepare("SELECT last_household_refresh_at FROM jl_refresh_state WHERE user_id = ? LIMIT 1").bind(userId).first<{ last_household_refresh_at: number | null }>();
    if (report.household) report.household.previousRefreshAt = priorRefresh?.last_household_refresh_at ?? null;
    const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
    const existing = codes.length
      ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(codes)).all<ExistingJlDonor>()
      : { results: [] as ExistingJlDonor[] };
    const matches = matchJlDonors(preview.donors, existing.results);
    if (!validHouseholdReviewMode(body.reviewMode) || body.reviewMode !== profile.importReviewMode) return Response.json({ error: "Your Import Review Mode changed after this preview. Refresh the preview before importing." }, { status: 409 });
    const codeOwners = codes.length ? await env.DB.prepare(`SELECT id,external_source,external_id,donor_code FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL AND (lower(external_id) IN (SELECT value FROM json_each(?)) OR lower(donor_code) IN (SELECT value FROM json_each(?)))`).bind(userId, JSON.stringify(codes), JSON.stringify(codes)).all<JlCodeOwner>() : { results: [] as JlCodeOwner[] };
    const candidateDonors = matches.map((match) => match.donor);
    const manual = candidateDonors.length
      ? await env.DB.prepare(`SELECT id, display_name, donor_code, external_id, email, phone, home_phone, address, last_name, primary_first_name, spouse, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, address_line_1, city, state, postal_code, country, contact_note FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'Manual'`).bind(userId).all<ManualDonorRow>()
      : { results: [] as ManualDonorRow[] };
    const candidateByCode = new Map(findLikelyManualDonorMatches(candidateDonors, manual.results).map((candidate) => [candidate.externalId.toLowerCase(), candidate]));
    const codeCollisions = findJlCodeCollisions(codeOwners.results);
    for (const conflict of findUnresolvableJlCodeOwners(codeOwners.results, new Set([...candidateByCode.values()].filter((candidate) => candidate.exactCodeMatch).map((candidate) => candidate.manualDonorId)))) if (!codeCollisions.some((item) => item.externalId === conflict.externalId)) codeCollisions.push(conflict);
    if (codeCollisions.length) return Response.json({ error: `JL Code ${codeCollisions[0].externalId} is attached to a different active donor. Resolve that duplicate before importing.` }, { status: 409 });
    const fullExisting = existing.results.length ? await env.DB.prepare(`SELECT id,owner_user_id,data_source,donor_code,external_source,external_id,display_name,email,phone,home_phone,address,last_name,primary_first_name,spouse,spouse_first_name,primary_title,spouse_title,alternate_mobile_phone,address_line_1,city,state,postal_code,country,contact_note,source_snapshot,created_at,updated_at FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(existing.results.map((row) => row.id))).all<FullJlDonorRow>() : { results: [] as FullJlDonorRow[] };
    const decisionByCode = new Map((body.mergeDecisions ?? []).map((decision) => [decision.externalId.toLowerCase(), decision]));
    const existingDecisionByCode = new Map((body.existingDonorDecisions ?? []).map((decision) => [decision.externalId.toLowerCase(), decision]));
    for (const candidate of candidateByCode.values()) {
      const decision = decisionByCode.get(candidate.externalId.toLowerCase());
      if (!decision || !["merge", "keep_separate", "review_later"].includes(decision.action) || decision.manualDonorId !== candidate.manualDonorId) {
        return Response.json({ error: `Review the possible manual donor match for JL ${candidate.externalId} before importing.` }, { status: 422 });
      }
      if (candidate.exactCodeMatch && decision.action === "keep_separate") {
        return Response.json({ error: `JL Code ${candidate.externalId} already belongs to a different donor. Merge it, choose Review later, or resolve the duplicate first.` }, { status: 409 });
      }
      report.household.duplicateDecisions.push({ externalId: candidate.externalId, action: decision.action, manualDonorId: decision.manualDonorId });
    }
    for (const match of matches) {
      const donor = match.donor;
      const contact = donor.contact!;
      const code = donor.donorCode ?? "";
      const candidate = candidateByCode.get(code.toLowerCase());
      const decision = decisionByCode.get(code.toLowerCase());
      const existingDecision = existingDecisionByCode.get(code.toLowerCase());
      let reviewedUpdates: Record<string, string | null> = {};
      if (match.existing && decision?.action !== "review_later") {
        const resolution = resolveReviewedJlUpdates(match, profile.importReviewMode, existingDecision, body.fieldDecisions ?? []);
        if (resolution.error) return Response.json({ error: `JL ${code}: ${resolution.error}` }, { status: resolution.error.includes("changed after") ? 409 : 422 });
        reviewedUpdates = resolution.updates as Record<string, string | null>;
        if (existingDecision && (profile.importReviewMode === "review_every" || match.changes.length > 0)) report.household.decisions.push({ externalId: code, action: existingDecision.action, fields: Object.fromEntries(match.changes.map((change) => [change.field, reviewedUpdates[change.field] !== undefined ? "use_jl" : "keep_local"])) });
      }
      const reviewedValue = (field: keyof ExistingJlDonor, incoming: string | null | undefined) => match.existing ? (Object.hasOwn(reviewedUpdates, field) ? reviewedUpdates[field] : match.existing[field] as string | null) : incoming ?? null;
      if (match.existing && candidate && decision?.action === "review_later") {
        ownedIds.delete(donor.id);
        if (report.household) report.household.reviewLater += 1;
        continue;
      }
      if (match.existing && candidate && decision?.action === "merge") {
        const manualDonor = manual.results.find((row) => row.id === candidate.manualDonorId)!;
        const priorJl = fullExisting.results.find((row) => row.id === match.existing!.id)!;
        const keep = (current: string | null | undefined, incoming: string | null | undefined) => current?.trim() ? current : incoming ?? null;
        const merged = { displayName: keep(manualDonor.display_name, reviewedValue("display_name", donor.name)), spouse: keep(manualDonor.spouse, reviewedValue("spouse_first_name", contact.spouseFirstName)), email: keep(manualDonor.email, reviewedValue("email", donor.email)), phone: keep(manualDonor.phone, reviewedValue("phone", donor.phone)), address: keep(manualDonor.address, reviewedValue("address", donor.address)), lastName: keep(manualDonor.last_name, reviewedValue("last_name", contact.lastName)), primaryFirstName: keep(manualDonor.primary_first_name, reviewedValue("primary_first_name", contact.primaryFirstName)), spouseFirstName: keep(manualDonor.spouse_first_name, reviewedValue("spouse_first_name", contact.spouseFirstName)), primaryTitle: keep(manualDonor.primary_title, reviewedValue("primary_title", contact.primaryTitle)), spouseTitle: keep(manualDonor.spouse_title, reviewedValue("spouse_title", contact.spouseTitle)), alternateMobilePhone: keep(manualDonor.alternate_mobile_phone, reviewedValue("alternate_mobile_phone", contact.alternateMobilePhone)), homePhone: keep(manualDonor.home_phone, reviewedValue("home_phone", contact.homePhone)), addressLine1: keep(manualDonor.address_line_1, reviewedValue("address_line_1", contact.addressLine1)), city: keep(manualDonor.city, reviewedValue("city", contact.city)), state: keep(manualDonor.state, reviewedValue("state", contact.state)), postalCode: keep(manualDonor.postal_code, reviewedValue("postal_code", contact.postalCode)), country: keep(manualDonor.country, reviewedValue("country", contact.country)), contactNote: manualDonor.contact_note };
        const [giftIds, givingIds, interactionIds, recommendationIds, paymentAuditIds, contactAuditIds] = await Promise.all([
          env.DB.prepare("SELECT id FROM gifts WHERE donor_id=?").bind(priorJl.id).all<{ id: string }>(), env.DB.prepare("SELECT id FROM giving_activities WHERE donor_id=? AND owner_user_id=?").bind(priorJl.id, userId).all<{ id: string }>(), env.DB.prepare("SELECT id FROM interactions WHERE donor_id=? AND user_id=?").bind(priorJl.id, userId).all<{ id: string }>(), env.DB.prepare("SELECT id FROM recommendations WHERE donor_id=? AND user_id=?").bind(priorJl.id, userId).all<{ id: string }>(), env.DB.prepare("SELECT id FROM jl_payment_assignment_audits WHERE donor_id=? AND user_id=?").bind(priorJl.id, userId).all<{ id: string }>(), env.DB.prepare("SELECT id FROM donor_contact_audits WHERE donor_id=? AND user_id=?").bind(priorJl.id, userId).all<{ id: string }>(),
        ]);
        const linked = { gifts: giftIds.results.map((row) => row.id), giving_activities: givingIds.results.map((row) => row.id), interactions: interactionIds.results.map((row) => row.id), recommendations: recommendationIds.results.map((row) => row.id), jl_payment_assignment_audits: paymentAuditIds.results.map((row) => row.id), donor_contact_audits: contactAuditIds.results.map((row) => row.id) };
        const manualBefore = { owner_user_id: userId, data_source: "live", donor_code: null, external_source: "Manual", external_id: null, display_name: manualDonor.display_name, spouse: manualDonor.spouse, email: manualDonor.email, phone: manualDonor.phone, address: manualDonor.address, last_name: manualDonor.last_name, primary_first_name: manualDonor.primary_first_name, spouse_first_name: manualDonor.spouse_first_name, primary_title: manualDonor.primary_title, spouse_title: manualDonor.spouse_title, alternate_mobile_phone: manualDonor.alternate_mobile_phone, home_phone: manualDonor.home_phone, address_line_1: manualDonor.address_line_1, city: manualDonor.city, state: manualDonor.state, postal_code: manualDonor.postal_code, country: manualDonor.country, contact_note: manualDonor.contact_note, source_snapshot: null };
        const manualAfter = { ...manualBefore, donor_code: code, external_source: "JL Solutions", external_id: code, display_name: merged.displayName, spouse: merged.spouse, email: merged.email, phone: merged.phone, address: merged.address, last_name: merged.lastName, primary_first_name: merged.primaryFirstName, spouse_first_name: merged.spouseFirstName, primary_title: merged.primaryTitle, spouse_title: merged.spouseTitle, alternate_mobile_phone: merged.alternateMobilePhone, home_phone: merged.homePhone, address_line_1: merged.addressLine1, city: merged.city, state: merged.state, postal_code: merged.postalCode, country: merged.country, contact_note: merged.contactNote, source_snapshot: JSON.stringify(sourceSnapshot(donor)) };
        const jlBefore = { ...Object.fromEntries(Object.entries(priorJl).filter(([field]) => field !== "id")), linked };
        ownedIds.set(donor.id, manualDonor.id);
        statements.push(
          env.DB.prepare("UPDATE gifts SET donor_id=? WHERE donor_id=?").bind(manualDonor.id, priorJl.id), env.DB.prepare("UPDATE giving_activities SET donor_id=? WHERE donor_id=? AND owner_user_id=?").bind(manualDonor.id, priorJl.id, userId), env.DB.prepare("UPDATE interactions SET donor_id=? WHERE donor_id=? AND user_id=?").bind(manualDonor.id, priorJl.id, userId), env.DB.prepare("UPDATE recommendations SET donor_id=? WHERE donor_id=? AND user_id=?").bind(manualDonor.id, priorJl.id, userId), env.DB.prepare("UPDATE jl_payment_assignment_audits SET donor_id=? WHERE donor_id=? AND user_id=?").bind(manualDonor.id, priorJl.id, userId), env.DB.prepare("UPDATE donor_contact_audits SET donor_id=? WHERE donor_id=? AND user_id=?").bind(manualDonor.id, priorJl.id, userId), env.DB.prepare("UPDATE donors SET archived_at=?,merged_into_donor_id=?,donor_code=NULL,external_source=NULL,external_id=NULL,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND external_source='JL Solutions' AND archived_at IS NULL").bind(now, manualDonor.id, now, priorJl.id, userId),
          env.DB.prepare(`UPDATE donors SET donor_code=?,external_source='JL Solutions',external_id=?,display_name=?,spouse=?,email=?,phone=?,address=?,last_name=?,primary_first_name=?,spouse_first_name=?,primary_title=?,spouse_title=?,alternate_mobile_phone=?,home_phone=?,address_line_1=?,city=?,state=?,postal_code=?,country=?,source_snapshot=?,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND external_source='Manual'`).bind(code, code, merged.displayName, merged.spouse, merged.email, merged.phone, merged.address, merged.lastName, merged.primaryFirstName, merged.spouseFirstName, merged.primaryTitle, merged.spouseTitle, merged.alternateMobilePhone, merged.homePhone, merged.addressLine1, merged.city, merged.state, merged.postalCode, merged.country, JSON.stringify(sourceSnapshot(donor)), now, manualDonor.id, userId),
          env.DB.prepare(`INSERT INTO donor_contact_audits (id,user_id,donor_id,action,changed_fields,before_json,after_json,created_at) VALUES (?,?,?,'merged_with_jl',?,?,?,?)`).bind(crypto.randomUUID(), userId, manualDonor.id, JSON.stringify(["externalSource", "externalId"]), JSON.stringify(manualBefore), JSON.stringify(manualAfter), now),
        );
        householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId: manualDonor.id, changeType: "merge", beforeJson: JSON.stringify(manualBefore), afterJson: JSON.stringify(manualAfter), now }, { id: crypto.randomUUID(), importId, userId, donorId: priorJl.id, changeType: "consolidated", beforeJson: JSON.stringify(jlBefore), afterJson: JSON.stringify({ mergedInto: manualDonor.id }), now });
        if (report.household) report.household.merged += 1;
        continue;
      }
      if (!match.existing) {
        if (candidate && decision?.action === "review_later") {
          ownedIds.delete(donor.id);
          if (report.household) report.household.reviewLater += 1;
          continue;
        }
        if (candidate && decision?.action === "merge") {
          const manualDonor = manual.results.find((row) => row.id === candidate.manualDonorId)!;
          const keep = (current: string | null | undefined, incoming: string | null | undefined) => current?.trim() ? current : incoming ?? null;
          const merged = {
            displayName: keep(manualDonor.display_name, donor.name), spouse: keep(manualDonor.spouse, contact.spouseFirstName), email: keep(manualDonor.email, donor.email), phone: keep(manualDonor.phone, donor.phone), address: keep(manualDonor.address, donor.address),
            lastName: keep(manualDonor.last_name, contact.lastName), primaryFirstName: keep(manualDonor.primary_first_name, contact.primaryFirstName), spouseFirstName: keep(manualDonor.spouse_first_name, contact.spouseFirstName), primaryTitle: keep(manualDonor.primary_title, contact.primaryTitle), spouseTitle: keep(manualDonor.spouse_title, contact.spouseTitle), alternateMobilePhone: keep(manualDonor.alternate_mobile_phone, contact.alternateMobilePhone), homePhone: keep(manualDonor.home_phone, contact.homePhone), addressLine1: keep(manualDonor.address_line_1, contact.addressLine1), city: keep(manualDonor.city, contact.city), state: keep(manualDonor.state, contact.state), postalCode: keep(manualDonor.postal_code, contact.postalCode), country: keep(manualDonor.country, contact.country), contactNote: manualDonor.contact_note,
          };
          ownedIds.set(donor.id, manualDonor.id);
          const before = { owner_user_id: userId, data_source: "live", donor_code: null, external_source: "Manual", external_id: null, display_name: manualDonor.display_name, spouse: manualDonor.spouse, email: manualDonor.email, phone: manualDonor.phone, address: manualDonor.address, last_name: manualDonor.last_name, primary_first_name: manualDonor.primary_first_name, spouse_first_name: manualDonor.spouse_first_name, primary_title: manualDonor.primary_title, spouse_title: manualDonor.spouse_title, alternate_mobile_phone: manualDonor.alternate_mobile_phone, home_phone: manualDonor.home_phone, address_line_1: manualDonor.address_line_1, city: manualDonor.city, state: manualDonor.state, postal_code: manualDonor.postal_code, country: manualDonor.country, contact_note: manualDonor.contact_note, source_snapshot: null };
          const after = { ...before, donor_code: code, external_source: "JL Solutions", external_id: code, display_name: merged.displayName, spouse: merged.spouse, email: merged.email, phone: merged.phone, address: merged.address, last_name: merged.lastName, primary_first_name: merged.primaryFirstName, spouse_first_name: merged.spouseFirstName, primary_title: merged.primaryTitle, spouse_title: merged.spouseTitle, alternate_mobile_phone: merged.alternateMobilePhone, home_phone: merged.homePhone, address_line_1: merged.addressLine1, city: merged.city, state: merged.state, postal_code: merged.postalCode, country: merged.country, contact_note: merged.contactNote, source_snapshot: JSON.stringify(sourceSnapshot(donor)) };
          householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId: manualDonor.id, changeType: "merge", beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after), now });
          if (report.household) report.household.merged += 1;
          statements.push(env.DB.prepare(`UPDATE donors SET donor_code=?, external_source='JL Solutions', external_id=?, display_name=?, spouse=?, email=?, phone=?, address=?, last_name=?, primary_first_name=?, spouse_first_name=?, primary_title=?, spouse_title=?, alternate_mobile_phone=?, home_phone=?, address_line_1=?, city=?, state=?, postal_code=?, country=?, source_snapshot=?, updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live' AND external_source='Manual'`)
            .bind(code, code, merged.displayName, merged.spouse, merged.email, merged.phone, merged.address, merged.lastName, merged.primaryFirstName, merged.spouseFirstName, merged.primaryTitle, merged.spouseTitle, merged.alternateMobilePhone, merged.homePhone, merged.addressLine1, merged.city, merged.state, merged.postalCode, merged.country, JSON.stringify(sourceSnapshot(donor)), now, manualDonor.id, userId));
          statements.push(env.DB.prepare(`INSERT INTO donor_contact_audits (id,user_id,donor_id,action,changed_fields,before_json,after_json,created_at) VALUES (?,?,?,'merged_with_jl',?,?,?,?)`)
            .bind(crypto.randomUUID(), userId, manualDonor.id, JSON.stringify(["externalSource", "externalId"]), JSON.stringify({ externalSource: "Manual", externalId: null }), JSON.stringify({ externalSource: "JL Solutions", externalId: code, contact: merged }), now));
          continue;
        }
        const donorId = crypto.randomUUID();
        ownedIds.set(donor.id, donorId);
        const inserted = { owner_user_id: userId, data_source: "live", donor_code: donor.donorCode, external_source: "JL Solutions", external_id: donor.donorCode, display_name: donor.name, spouse: contact.spouseFirstName, email: donor.email, phone: donor.phone, address: donor.address, last_name: contact.lastName, primary_first_name: contact.primaryFirstName, spouse_first_name: contact.spouseFirstName, primary_title: contact.primaryTitle, spouse_title: contact.spouseTitle, alternate_mobile_phone: contact.alternateMobilePhone, home_phone: contact.homePhone, address_line_1: contact.addressLine1, city: contact.city, state: contact.state, postal_code: contact.postalCode, country: contact.country, contact_note: null, source_snapshot: JSON.stringify(sourceSnapshot(donor)) };
        householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId, changeType: "insert", beforeJson: null, afterJson: JSON.stringify(inserted), now });
        if (report.household) report.household.created += 1;
        statements.push(env.DB.prepare(`INSERT INTO donors (id, owner_user_id, data_source, donor_code, external_source, external_id, display_name, spouse, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot, created_at, updated_at)
          VALUES (?, ?, 'live', ?, 'JL Solutions', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(donorId, userId, donor.donorCode, donor.donorCode, donor.name, contact.spouseFirstName, donor.email, donor.phone, donor.address, contact.lastName, contact.primaryFirstName, contact.spouseFirstName, contact.primaryTitle, contact.spouseTitle, contact.alternateMobilePhone, contact.homePhone, contact.addressLine1, contact.city, contact.state, contact.postalCode, contact.country, JSON.stringify(sourceSnapshot(donor)), now, now));
      } else {
        const updates = Object.entries(reviewedUpdates);
        if (!updates.length && !match.changes.length) {
          ownedIds.set(donor.id, match.existing.id);
          continue;
        }
        const assignments = updates.map(([field]) => `${field} = ?`);
        assignments.push("source_snapshot = ?", "updated_at = ?");
        ownedIds.set(donor.id, match.existing.id);
        const before = { ...Object.fromEntries(updates.map(([field]) => [field, match.existing![field as keyof ExistingJlDonor] ?? null])), source_snapshot: match.existing.source_snapshot };
        const after = { ...Object.fromEntries(updates), source_snapshot: JSON.stringify(sourceSnapshot(donor)) };
        householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId: match.existing.id, changeType: "update", beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after), now });
        if (report.household && updates.length) report.household.updated += 1;
        statements.push(env.DB.prepare(`UPDATE donors SET ${assignments.join(", ")} WHERE id = ? AND owner_user_id = ? AND data_source = 'live'`)
          .bind(...updates.map(([, value]) => value), JSON.stringify(sourceSnapshot(donor)), now, match.existing.id, userId));
      }
    }
  } else {
    const generalCodes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
    const existingGeneral = generalCodes.length ? await env.DB.prepare(`SELECT id,donor_code,external_source,display_name,spouse,email,phone,address,last_name,primary_first_name,spouse_first_name,home_phone,address_line_1,city,state,postal_code,country FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL AND lower(donor_code) IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(generalCodes)).all<GeneralExistingDonor>() : { results: [] as GeneralExistingDonor[] };
    if (body.updateExisting && existingGeneral.results.some((row) => row.external_source === "JL Solutions")) {
      return Response.json({ error: "Existing JL donors cannot be updated through the generic spreadsheet path. Preview this as a JL household export and resolve every required donor review first." }, { status: 422 });
    }
    const byCode = new Map(existingGeneral.results.map((row) => [row.donor_code.toLowerCase(), row]));
    for (const donor of preview.donors) {
      const contact = donor.contact!;
      const existingDonor = donor.donorCode ? byCode.get(donor.donorCode.toLowerCase()) : undefined;
      const values = { display_name: donor.name, spouse: donor.spouse, email: donor.email, phone: donor.phone, address: donor.address, last_name: contact.lastName, primary_first_name: contact.primaryFirstName, spouse_first_name: contact.spouseFirstName, home_phone: contact.homePhone, address_line_1: contact.addressLine1, city: contact.city, state: contact.state, postal_code: contact.postalCode, country: contact.country };
      if (existingDonor) {
        ownedIds.set(donor.id, existingDonor.id);
        if (body.updateExisting) {
          const before = Object.fromEntries(Object.keys(values).map((field) => [field, existingDonor[field as keyof GeneralExistingDonor] ?? null]));
          householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId: existingDonor.id, changeType: "update", beforeJson: JSON.stringify(before), afterJson: JSON.stringify(values), now });
          report.household.updated += 1;
          statements.push(env.DB.prepare(`UPDATE donors SET display_name=?,spouse=?,email=?,phone=?,address=?,last_name=?,primary_first_name=?,spouse_first_name=?,home_phone=?,address_line_1=?,city=?,state=?,postal_code=?,country=?,updated_at=? WHERE id=? AND owner_user_id=? AND data_source='live'`).bind(...Object.values(values), now, existingDonor.id, userId));
        } else {
          householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId: existingDonor.id, changeType: "update", beforeJson: JSON.stringify({}), afterJson: JSON.stringify({}), now });
        }
        continue;
      }
      const donorId = crypto.randomUUID();
      ownedIds.set(donor.id, donorId);
      const inserted = { owner_user_id: userId, data_source: "live", donor_code: donor.donorCode, external_source: null, external_id: null, ...values, primary_title: contact.primaryTitle, spouse_title: contact.spouseTitle, alternate_mobile_phone: contact.alternateMobilePhone, contact_note: null, source_snapshot: null };
      householdChangeRows.push({ id: crypto.randomUUID(), importId, userId, donorId, changeType: "insert", beforeJson: null, afterJson: JSON.stringify(inserted), now });
      report.household.created += 1;
      statements.push(env.DB.prepare(`INSERT INTO donors
        (id,owner_user_id,data_source,donor_code,display_name,spouse,email,phone,address,last_name,primary_first_name,spouse_first_name,primary_title,spouse_title,alternate_mobile_phone,home_phone,address_line_1,city,state,postal_code,country,created_at,updated_at)
        VALUES (?,?,'live',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(donorId, userId, donor.donorCode, donor.name, donor.spouse, donor.email, donor.phone, donor.address, contact.lastName, contact.primaryFirstName, contact.spouseFirstName, contact.primaryTitle, contact.spouseTitle, contact.alternateMobilePhone, contact.homePhone, contact.addressLine1, contact.city, contact.state, contact.postalCode, contact.country, now, now));
    }
  }
  report.imported.donors = report.household.created + report.household.updated + report.household.merged;
  report.firstRelationshipId = preview.donors.map((donor) => ownedIds.get(donor.id)).find(Boolean) ?? null;

  const giftRows = preview.gifts.map((gift) => ({ ...gift, donorId: ownedIds.get(gift.donorId), now }));
  const interactionRows = preview.interactions.map((interaction) => ({ ...interaction, donorId: ownedIds.get(interaction.donorId), now, userId, source: `import:${importId}` }));
  const reminderRows = preview.reminders.map((reminder) => ({ ...reminder, donorId: ownedIds.get(reminder.donorId), now, userId }));
  for (const change of householdChangeRows) {
    const originalId = preview.donors.find((donor) => ownedIds.get(donor.id) === change.donorId)?.id;
    if (!originalId) continue;
    const after = JSON.parse(change.afterJson) as Record<string, unknown>;
    after.__batchLinked = { gifts: preview.gifts.filter((item) => item.donorId === originalId).map((item) => item.id), interactions: preview.interactions.filter((item) => item.donorId === originalId).map((item) => item.id), recommendations: preview.reminders.filter((item) => item.donorId === originalId).map((item) => item.id) };
    change.afterJson = JSON.stringify(after);
  }

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
  if (householdChangeRows.length) {
    const importedDonorIds = householdChangeRows.map((change) => change.donorId);
    statements.push(
      env.DB.prepare("UPDATE donors SET owner_user_id = ?, data_source = 'live' WHERE owner_user_id = ? AND id IN (SELECT value FROM json_each(?))").bind(userId, userId, JSON.stringify(importedDonorIds)),
      ...chunkJsonRows(householdChangeRows).map((chunk) => env.DB.prepare(`INSERT INTO household_import_changes (id,import_id,user_id,donor_id,change_type,before_json,after_json,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.importId'),json_extract(value,'$.userId'),json_extract(value,'$.donorId'),json_extract(value,'$.changeType'),json_extract(value,'$.beforeJson'),json_extract(value,'$.afterJson'),json_extract(value,'$.now') FROM json_each(?)`).bind(chunk)),
    );
  }
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
