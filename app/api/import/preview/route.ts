import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { buildImportPreview, type ColumnMapping, type ImportRow } from "../../../../lib/import/recognition";
import { buildJlPreview } from "../../../../lib/import/jl-solutions";
import { findJlCodeCollisions, findUnresolvableJlCodeOwners, matchJlDonors, type ExistingJlDonor, type JlCodeOwner } from "../../../../lib/import/jl-match";
import { buildJlDonationPreview, paymentActivitiesForAssignment, stableTransactionId } from "../../../../lib/import/jl-donations";
import { classifyJlImportType, countStrongDonationIndicators } from "../../../../lib/import/jl-export-type";
import { matchJlDonationActivities, type ExistingGivingActivity, type MatchedHousehold } from "../../../../lib/import/jl-donation-match";
import { findFingerprintCrossImportMatches, findStableIdCrossImportMatches, toExistingDonationRecord, type RawExistingDonationRow } from "../../../../lib/import/jl-donation-cross-import";
import { buildRejectedRows } from "../../../../lib/import/jl-donation-rejection-review";
import { chunkJsonRows } from "../../../../lib/import/d1-json-chunks";
import { isPreviewSessionUsable, isReopenableForFollowUp, parseDraftDecisions, previewSessionExpiresAt, reconstructRowsFromChunks, type PreviewSessionRow } from "../../../../lib/import/preview-session";
import { buildPaymentCandidates, OPEN_PLEDGES_FOR_DONORS_SQL, type OpenPledge, type RememberedPaymentDecision } from "../../../../lib/import/jl-payment-assignment";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { donationExportRange, isoDate } from "../../../../lib/import/jl-refresh";
import { ACTIVE_PAYMENT_ASSIGNMENTS_SQL } from "../../../../lib/import/import-deduplication";
import { findLikelyManualDonorMatches, type ManualDonorMatchRow } from "../../../../lib/donors/merge-preview";
import { buildExistingDonorReviews } from "../../../../lib/import/household-review";
import { pendingGiftMatches, type PendingGiftMatchRow } from "../../../../lib/giving/management";

type PreviewRequest = { rows?: ImportRow[]; mapping?: ColumnMapping; fileHash?: string; fileName?: string; compactPaymentStatus?: "review" | "fully_paid"; forceType?: "household" | "donation"; previewSessionId?: string };

// Persists this donation file's parsed rows server-side, owner-scoped, as a
// durable review draft: the final commit sends this id instead of the
// entire file again, and the same row accumulates the user's review
// decisions as they work through them (see /api/import/draft). If an open
// (status='draft'), unexpired draft already exists for this exact owner +
// fileHash, it is reused and its decisions are returned for restoration --
// the SAME file re-previewed is not a reason to lose review progress.
// Any of this owner's other expired drafts are opportunistically cleaned
// up in the same batch.
async function upsertDonationDraft(ownerUserId: string, fileHash: string, fileName: string, importType: string, rows: ImportRow[]): Promise<{ previewSessionId: string; restoredDecisions: Record<string, Record<string, unknown>> }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare("SELECT id, owner_user_id, file_hash, file_name, mapping_json, force_type, row_count, decisions_json, status, progress_resolved, progress_total, created_at, updated_at, expires_at FROM import_preview_sessions WHERE owner_user_id = ? AND file_hash = ? AND status = 'draft' ORDER BY updated_at DESC LIMIT 1").bind(ownerUserId, fileHash).first<PreviewSessionRow>();
  if (isPreviewSessionUsable(existing, ownerUserId, nowSeconds)) {
    await env.DB.prepare("UPDATE import_preview_sessions SET updated_at = ?, expires_at = ? WHERE id = ?").bind(nowSeconds, previewSessionExpiresAt(nowSeconds), existing.id).run();
    return { previewSessionId: existing.id, restoredDecisions: parseDraftDecisions(existing.decisions_json) };
  }

  const sessionId = crypto.randomUUID();
  const expiresAt = previewSessionExpiresAt(nowSeconds);
  const expiredSessions = await env.DB.prepare("SELECT id FROM import_preview_sessions WHERE owner_user_id = ? AND (expires_at <= ? OR status != 'draft')").bind(ownerUserId, nowSeconds).all<{ id: string }>();
  const expiredIds = expiredSessions.results.map((row) => row.id);
  await env.DB.batch([
    ...expiredIds.map((id) => env.DB.prepare("DELETE FROM import_preview_session_chunks WHERE session_id = ?").bind(id)),
    ...(expiredIds.length ? [env.DB.prepare(`DELETE FROM import_preview_sessions WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(expiredIds))] : []),
    env.DB.prepare("INSERT INTO import_preview_sessions (id, owner_user_id, file_hash, file_name, mapping_json, force_type, row_count, decisions_json, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, '{}', ?, ?, '{}', 'draft', ?, ?, ?)").bind(sessionId, ownerUserId, fileHash, fileName, importType, rows.length, nowSeconds, nowSeconds, expiresAt),
    ...chunkJsonRows(rows).map((chunk, index) => env.DB.prepare("INSERT INTO import_preview_session_chunks (session_id, chunk_index, rows_json) VALUES (?, ?, ?)").bind(sessionId, index, chunk)),
  ]);
  return { previewSessionId: sessionId, restoredDecisions: {} };
}

// Loads an existing draft's own stored rows for the resume flow, where the
// client sends only the draft id -- never a client-supplied fileHash/rows,
// so a resumed review can never be pointed at different content than the
// exact file it was created from. A committed session may also be reopened
// this way -- specifically so "review later" rows from a completed import
// remain resolvable in a later session (see isReopenableForFollowUp);
// re-submitting already-imported rows is always safe, since the commit
// route's own duplicate protection recognizes them as already imported.
async function loadDraftRows(ownerUserId: string, previewSessionId: string): Promise<{ session: PreviewSessionRow; rows: ImportRow[] } | null> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare("SELECT id, owner_user_id, file_hash, file_name, mapping_json, force_type, row_count, decisions_json, status, progress_resolved, progress_total, created_at, updated_at, expires_at FROM import_preview_sessions WHERE id = ?").bind(previewSessionId).first<PreviewSessionRow>();
  if (!isReopenableForFollowUp(session, ownerUserId, nowSeconds)) return null;
  const chunkRows = await env.DB.prepare("SELECT rows_json FROM import_preview_session_chunks WHERE session_id = ? ORDER BY chunk_index").bind(previewSessionId).all<{ rows_json: string }>();
  // A committed session stays committed -- reopening it for a follow-up
  // pass on its review-later rows must never make it look like an
  // in-progress draft (or eligible for the ordinary "resume unfinished
  // import" list), only its activity window is extended.
  if (session.status === "draft") await env.DB.prepare("UPDATE import_preview_sessions SET updated_at = ?, expires_at = ? WHERE id = ?").bind(nowSeconds, previewSessionExpiresAt(nowSeconds), previewSessionId).run();
  else await env.DB.prepare("UPDATE import_preview_sessions SET expires_at = ? WHERE id = ?").bind(previewSessionExpiresAt(nowSeconds), previewSessionId).run();
  return { session, rows: reconstructRowsFromChunks(chunkRows.results.map((row) => row.rows_json)) };
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const body = await request.json() as PreviewRequest;

  // Resume flow: the client sends only the draft id (no file at all) --
  // never trust a client-supplied fileHash/rows here, so a resumed review
  // can only ever be rebuilt from the exact rows that draft was created
  // from, tied to the authenticated owner.
  const resumeSessionId = typeof body.previewSessionId === "string" ? body.previewSessionId.trim() : "";
  let rows: ImportRow[];
  let restoredDecisions: Record<string, Record<string, unknown>> = {};
  let resumedFileHash: string | undefined;
  let resumedFileName: string | undefined;
  let resumedFollowUp = false;
  if (resumeSessionId) {
    const draft = await loadDraftRows(profile.id, resumeSessionId);
    if (!draft) return Response.json({ error: "This draft has expired or no longer exists. Choose the file again to start a new review.", draftUnavailable: true }, { status: 410 });
    rows = draft.rows;
    restoredDecisions = parseDraftDecisions(draft.session.decisions_json);
    resumedFileHash = draft.session.file_hash;
    resumedFileName = draft.session.file_name;
    // Reopening an already-committed import: only rows explicitly saved as
    // "review later" still need a decision -- skip/import_anyway/accepted
    // rows are left exactly as they were (harmless to resubmit; duplicate
    // protection recognizes them as already imported).
    resumedFollowUp = draft.session.status === "committed";
    if (resumedFollowUp) {
      for (const map of Object.values(restoredDecisions)) {
        if (!map || typeof map !== "object") continue;
        for (const [key, decision] of Object.entries(map)) {
          if (decision && typeof decision === "object" && (decision as { action?: unknown }).action === "review_later") delete map[key];
        }
      }
    }
  } else {
    rows = Array.isArray(body.rows) ? body.rows : [];
  }
  const fileHash = resumedFileHash ?? body.fileHash ?? "";
  if (!rows.length || rows.length > 25000 || !/^[a-f0-9]{64}$/.test(fileHash)) return Response.json({ error: "The preview could not be validated" }, { status: 422 });
  const columns = Object.keys(rows[0] ?? {});
  const importType = body.forceType ?? classifyJlImportType(columns, rows);
  if (importType === "ambiguous") {
    return Response.json({
      profile: "ambiguous",
      ambiguous: {
        donationIndicatorCount: countStrongDonationIndicators(columns, rows),
        message: "This file has some donation-shaped columns but is not clearly one type. Choose whether this is a Household export or a Donation export before continuing.",
      },
    });
  }
  if (importType === "donation") {
    const donationPreview = await buildJlDonationPreview(rows);
    // A row with an unresolved date problem stays in the general review
    // queue instead of being swept into payment assignment, which has no
    // way to correct a date -- one queue, one place to resolve it.
    const paymentActivities = paymentActivitiesForAssignment(donationPreview.activities.filter((activity) => activity.dateIssue === null), columns);
    const paymentFingerprints = new Set(paymentActivities.map((activity) => activity.fingerprint));
    const standardPreview = { ...donationPreview, activities: donationPreview.activities.filter((activity) => !paymentFingerprints.has(activity.fingerprint)) };
    const codes = [...new Set(donationPreview.activities.map((activity) => activity.externalHouseholdId.toLowerCase()).filter(Boolean))];
    const fingerprints = donationPreview.activities.map((activity) => activity.fingerprint);
    const households = codes.length ? await env.DB.prepare(`SELECT id, external_id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(codes)).all<MatchedHousehold & { display_name: string }>() : { results: [] as Array<MatchedHousehold & { display_name: string }> };
    const existing = fingerprints.length ? await env.DB.prepare(`SELECT id, donor_id, activity_date, committed_cents, source_campaign, source_fingerprint, paid_cents, balance_cents, category, source_snapshot, created_at FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(fingerprints)).all<ExistingGivingActivity & RawExistingDonationRow>() : { results: [] as Array<ExistingGivingActivity & RawExistingDonationRow> };
    const match = matchJlDonationActivities(standardPreview, households.results, existing.results);
    // Cross-import duplicate protection: a stable transaction ID already
    // seen on a prior import is a confirmed duplicate regardless of this
    // file's own fingerprint; a matching content fingerprint with no
    // changed payment fields (the same rows matchJlDonationActivities
    // already treats as "already imported") is a possible duplicate worth
    // surfacing. Neither query touches or mutates any financial record.
    const existingByFingerprintRecord = new Map(existing.results.map((record) => [record.source_fingerprint, toExistingDonationRecord(record)]));
    const proposedUpdateFingerprints = new Set(match.proposedUpdates.map((activity) => activity.fingerprint));
    const unchangedExistingActivities = match.matched.filter((activity) => existingByFingerprintRecord.has(activity.fingerprint) && !proposedUpdateFingerprints.has(activity.fingerprint));
    const hasStableIds = donationPreview.activities.some((activity) => stableTransactionId(activity.sourceValues) !== null);
    const broadExisting = hasStableIds
      ? await env.DB.prepare(`SELECT id, donor_id, activity_date, committed_cents, source_campaign, source_snapshot, created_at FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions'`).bind(profile.id).all<RawExistingDonationRow>()
      : { results: [] as RawExistingDonationRow[] };
    const stableIdMatches = findStableIdCrossImportMatches(match.newActivities, broadExisting.results.map(toExistingDonationRecord));
    const crossImportMatches = [...stableIdMatches, ...findFingerprintCrossImportMatches(unchangedExistingActivities, existingByFingerprintRecord, new Set(stableIdMatches.map((item) => item.fingerprint)))];
    const crossImportSourceByFingerprint = new Map([...match.newActivities, ...unchangedExistingActivities].map((activity) => [activity.fingerprint, activity]));
    const range = donationExportRange([...match.matched, ...paymentActivities]);
    const donorIds = households.results.map((household) => household.id);
    const openPledges = donorIds.length
      ? await env.DB.prepare(OPEN_PLEDGES_FOR_DONORS_SQL).bind(profile.id, JSON.stringify(donorIds)).all<OpenPledge>()
      : { results: [] as OpenPledge[] };
    const paymentFingerprintsList = paymentActivities.map((activity) => activity.fingerprint);
    const remembered = paymentFingerprintsList.length
      ? await env.DB.prepare(ACTIVE_PAYMENT_ASSIGNMENTS_SQL).bind(profile.id, JSON.stringify(paymentFingerprintsList)).all<RememberedPaymentDecision>()
      : { results: [] as RememberedPaymentDecision[] };
    const rememberedFingerprints = new Set(remembered.results.map((decision) => decision.payment_fingerprint));
    const rememberedWithLegacyGifts = [...remembered.results, ...existing.results.filter((activity) => paymentFingerprints.has(activity.source_fingerprint) && !rememberedFingerprints.has(activity.source_fingerprint)).map((activity) => ({ payment_fingerprint: activity.source_fingerprint, decision_type: "new_gift" as const, pledge_activity_id: null, applied_import_id: "existing-gift" }))];
    const paymentAssignments = buildPaymentCandidates(paymentActivities, households.results, openPledges.results, rememberedWithLegacyGifts);
    const publicPaymentAssignments = paymentAssignments.map(({ donorId, openPledges: candidatePledges, ...candidate }) => ({ ...candidate, donorMatched: Boolean(donorId), openPledges: candidatePledges.map((pledge) => ({ id: pledge.id, activity_date: pledge.activity_date, committed_cents: pledge.committed_cents, paid_cents: pledge.paid_cents, balance_cents: pledge.balance_cents, description: pledge.description, source_campaign: pledge.source_campaign })) }));
    const pendingInputs = [
      ...match.newActivities.map((activity) => ({ fingerprint: activity.fingerprint, donorId: activity.donorId, activityDate: activity.activityDate, committedCents: activity.committedCents })),
      ...paymentAssignments.filter((candidate) => candidate.donorId && !candidate.alreadyApplied).map((candidate) => ({ fingerprint: candidate.fingerprint, donorId: candidate.donorId!, activityDate: candidate.paymentDate, committedCents: candidate.amountCents })),
    ];
    const pendingDonorIds = [...new Set(pendingInputs.map((item) => item.donorId))];
    const pending = pendingDonorIds.length ? await env.DB.prepare(`SELECT id,donor_id,activity_date,committed_cents,description,private_note,workspace_status,category,confirmed_by_activity_id FROM giving_activities WHERE owner_user_id=? AND record_origin='live' AND category='pending_gift' AND workspace_status='active' AND confirmed_by_activity_id IS NULL AND donor_id IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(pendingDonorIds)).all<PendingGiftMatchRow>() : { results: [] as PendingGiftMatchRow[] };
    const pendingMatches = pendingGiftMatches(pendingInputs, pending.results).map((match) => ({ fingerprint: match.fingerprint, candidates: match.candidates.map((candidate) => ({ id: candidate.id, activityDate: candidate.activity_date, amountCents: candidate.committed_cents, designation: candidate.description, note: candidate.private_note })) }));
    // Persist the parsed rows server-side (or reuse this owner's existing
    // open draft for the exact same fileHash, restoring its decisions) so
    // the final commit request can send this id instead of re-uploading
    // the entire file, and so review progress survives a refresh.
    const draft = resumeSessionId ? { previewSessionId: resumeSessionId, restoredDecisions } : await upsertDonationDraft(profile.id, fileHash, resumedFileName ?? body.fileName ?? "", "donation", rows);
    return Response.json({ profile: "jl-donations", previewSessionId: draft.previewSessionId, restoredDecisions: draft.restoredDecisions, resumedFollowUp, fileName: resumedFileName ?? body.fileName ?? "", fileHash, donation: {
      rows: rows.length,
      matchedRows: match.matched.length + paymentAssignments.filter((candidate) => candidate.donorId).length,
      unknownHousehold: match.unknownHousehold + paymentAssignments.filter((candidate) => !candidate.donorId).length,
      duplicateSourceRows: donationPreview.duplicateRows.length,
      zeroDollar: donationPreview.counts.zeroDollar,
      openPledges: openPledges.results.length,
      needsReview: match.needsReview,
      suspiciousDates: donationPreview.counts.suspiciousDates,
      nonfinancial: match.nonfinancial,
      newActivities: match.newActivities.length,
      proposedUpdates: match.proposedUpdates.length,
      alreadyImported: match.alreadyImported + paymentAssignments.filter((candidate) => candidate.alreadyApplied).length,
      conflicts: match.unknownHousehold + match.needsReview + paymentAssignments.filter((candidate) => !candidate.alreadyApplied).length,
      reviewRows: match.reviewActivities.map((activity) => ({
        row: activity.rowNumber,
        fingerprint: activity.fingerprint,
        reason: activity.reviewReason ?? "Row requires review",
        donor: activity.sourceName || null,
        jlCode: activity.externalHouseholdId || null,
        transactionType: activity.itemType || null,
        campaign: activity.sourceCampaign || null,
        date: activity.activityDate,
        originalDateValue: activity.sourceValues["Due Date"] || activity.sourceValues.Date || null,
        amountCents: activity.committedCents,
        duplicateGroupKey: activity.duplicateGroupKey,
        duplicateGroupSize: activity.duplicateGroupSize,
        dateIssue: activity.dateIssue,
        resolvable: activity.duplicateStatus === "possible_duplicate" || activity.dateIssue !== null,
      })),
      rejectedRows: donationPreview.duplicateRows.length + match.unknownHousehold + match.nonfinancial,
      rejectedRowDetails: buildRejectedRows(donationPreview.duplicateRows, match.unknownActivities, match.nonfinancialActivities),
      rangeStart: isoDate(range.start),
      rangeEnd: isoDate(range.end),
      paymentAssignments: publicPaymentAssignments,
      pendingGiftMatches: pendingMatches,
      crossImportRows: crossImportMatches.map((item) => {
        const activity = crossImportSourceByFingerprint.get(item.fingerprint);
        return {
          fingerprint: item.fingerprint,
          matchType: item.matchType,
          reason: item.reason,
          row: activity?.rowNumber ?? null,
          donor: activity?.sourceName || null,
          jlCode: activity?.externalHouseholdId || null,
          campaign: activity?.sourceCampaign || null,
          date: activity?.activityDate ?? null,
          amountCents: activity?.committedCents ?? null,
          existingActivityDate: item.existing.activityDate,
          existingAmountCents: item.existing.committedCents,
          existingCampaign: item.existing.sourceCampaign,
          existingImportedAt: item.existing.importedAt,
        };
      }),
    } });
  }
  const jlDetected = importType === "household";
  const preview = jlDetected ? buildJlPreview(rows, fileHash) : buildImportPreview(rows, body.mapping ?? {}, fileHash);
  if (!jlDetected) return Response.json({ profile: "general", preview });

  const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
  const existing = codes.length
    ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(codes)).all<ExistingJlDonor>()
    : { results: [] as ExistingJlDonor[] };
  const matches = matchJlDonors(preview.donors, existing.results);
  const conflicts = matches.flatMap((match) => match.conflicts);
  const changes = matches.flatMap((match) => match.changes);
  const codeOwners = codes.length
    ? await env.DB.prepare(`SELECT id, external_source, external_id, donor_code FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND (lower(external_id) IN (SELECT value FROM json_each(?)) OR lower(donor_code) IN (SELECT value FROM json_each(?)))`).bind(profile.id, JSON.stringify(codes), JSON.stringify(codes)).all<JlCodeOwner>()
    : { results: [] as JlCodeOwner[] };
  const candidateDonors = matches.map((match) => match.donor);
  const manual = candidateDonors.length
    ? await env.DB.prepare(`SELECT id, display_name, donor_code, external_id, email, phone, home_phone, address_line_1, city, state, postal_code, last_name, primary_first_name, spouse, spouse_first_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'Manual'`).bind(profile.id).all<ManualDonorMatchRow>()
    : { results: [] as ManualDonorMatchRow[] };
  const mergeCandidates = findLikelyManualDonorMatches(candidateDonors, manual.results);
  const existingDonorReviews = buildExistingDonorReviews(matches, profile.importReviewMode);
  const codeCollisions = findJlCodeCollisions(codeOwners.results);
  for (const conflict of findUnresolvableJlCodeOwners(codeOwners.results, new Set(mergeCandidates.filter((candidate) => candidate.exactCodeMatch).map((candidate) => candidate.manualDonorId)))) if (!codeCollisions.some((item) => item.externalId === conflict.externalId)) codeCollisions.push(conflict);
  return Response.json({
    profile: "jl-solutions",
    preview,
    jl: {
      households: preview.donors.length,
      newRelationships: matches.filter((match) => !match.existing).length,
      existingRelationships: matches.filter((match) => match.existing).length,
      recordsWithUpdates: matches.filter((match) => match.changes.length > 0).length,
      changes,
      conflicts,
      codeCollisions,
      reviewMode: profile.importReviewMode,
      existingDonorReviews,
      mergeCandidates,
      duplicateRows: preview.rejectedRows.filter((row) => /duplicate/i.test(row.reason)).length,
      rejectedRows: preview.rejectedRows.length,
    },
  });
}
