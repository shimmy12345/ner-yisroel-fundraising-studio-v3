import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { buildImportPreview, type ColumnMapping, type ImportRow } from "../../../../lib/import/recognition";
import { buildJlPreview, isJlSolutionsExport } from "../../../../lib/import/jl-solutions";
import { findJlCodeCollisions, findUnresolvableJlCodeOwners, matchJlDonors, type ExistingJlDonor, type JlCodeOwner } from "../../../../lib/import/jl-match";
import { buildJlDonationPreview, isCompactJlDonationExport, isJlDonationExport } from "../../../../lib/import/jl-donations";
import { matchJlDonationActivities, type ExistingGivingActivity, type MatchedHousehold } from "../../../../lib/import/jl-donation-match";
import { buildPaymentCandidates, OPEN_PLEDGES_FOR_DONORS_SQL, type OpenPledge, type RememberedPaymentDecision } from "../../../../lib/import/jl-payment-assignment";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { donationExportRange, isoDate } from "../../../../lib/import/jl-refresh";
import { ACTIVE_PAYMENT_ASSIGNMENTS_SQL } from "../../../../lib/import/import-deduplication";
import { findLikelyManualDonorMatches, type ManualDonorMatchRow } from "../../../../lib/donors/merge-preview";
import { buildExistingDonorReviews } from "../../../../lib/import/household-review";
import { pendingGiftMatches, type PendingGiftMatchRow } from "../../../../lib/giving/management";

type PreviewRequest = { rows?: ImportRow[]; mapping?: ColumnMapping; fileHash?: string; compactPaymentStatus?: "review" | "fully_paid" };

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const body = await request.json() as PreviewRequest;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const fileHash = body.fileHash ?? "";
  if (!rows.length || rows.length > 25000 || !/^[a-f0-9]{64}$/.test(fileHash)) return Response.json({ error: "The preview could not be validated" }, { status: 422 });
  const columns = Object.keys(rows[0] ?? {});
  if (isJlDonationExport(columns)) {
    const compactPaymentExport = isCompactJlDonationExport(columns);
    const donationPreview = await buildJlDonationPreview(rows);
    const codes = [...new Set(donationPreview.activities.map((activity) => activity.externalHouseholdId.toLowerCase()).filter(Boolean))];
    const fingerprints = donationPreview.activities.map((activity) => activity.fingerprint);
    const households = codes.length ? await env.DB.prepare(`SELECT id, external_id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(codes)).all<MatchedHousehold & { display_name: string }>() : { results: [] as Array<MatchedHousehold & { display_name: string }> };
    const existing = fingerprints.length ? await env.DB.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category, source_snapshot FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(fingerprints)).all<ExistingGivingActivity>() : { results: [] as ExistingGivingActivity[] };
    const match = matchJlDonationActivities(donationPreview, households.results, existing.results);
    const range = donationExportRange(match.matched);
    const donorIds = households.results.map((household) => household.id);
    const openPledges = compactPaymentExport && donorIds.length
      ? await env.DB.prepare(OPEN_PLEDGES_FOR_DONORS_SQL).bind(profile.id, JSON.stringify(donorIds)).all<OpenPledge>()
      : { results: [] as OpenPledge[] };
    const remembered = compactPaymentExport && fingerprints.length
      ? await env.DB.prepare(ACTIVE_PAYMENT_ASSIGNMENTS_SQL).bind(profile.id, JSON.stringify(fingerprints)).all<RememberedPaymentDecision>()
      : { results: [] as RememberedPaymentDecision[] };
    const paymentAssignments = compactPaymentExport ? buildPaymentCandidates(donationPreview.activities, households.results, openPledges.results, remembered.results) : [];
    const publicPaymentAssignments = paymentAssignments.map(({ donorId, openPledges: candidatePledges, ...candidate }) => ({ ...candidate, donorMatched: Boolean(donorId), openPledges: candidatePledges.map((pledge) => ({ id: pledge.id, activity_date: pledge.activity_date, committed_cents: pledge.committed_cents, paid_cents: pledge.paid_cents, balance_cents: pledge.balance_cents, description: pledge.description, source_campaign: pledge.source_campaign })) }));
    const pendingInputs = compactPaymentExport
      ? paymentAssignments.filter((candidate) => candidate.donorId && !candidate.alreadyApplied).map((candidate) => ({ fingerprint: candidate.fingerprint, donorId: candidate.donorId!, activityDate: candidate.paymentDate, committedCents: candidate.amountCents }))
      : match.newActivities.map((activity) => ({ fingerprint: activity.fingerprint, donorId: activity.donorId, activityDate: activity.activityDate, committedCents: activity.committedCents }));
    const pendingDonorIds = [...new Set(pendingInputs.map((item) => item.donorId))];
    const pending = pendingDonorIds.length ? await env.DB.prepare(`SELECT id,donor_id,activity_date,committed_cents,description,private_note,workspace_status,category,confirmed_by_activity_id FROM giving_activities WHERE owner_user_id=? AND record_origin='live' AND category='pending_gift' AND workspace_status='active' AND confirmed_by_activity_id IS NULL AND donor_id IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(pendingDonorIds)).all<PendingGiftMatchRow>() : { results: [] as PendingGiftMatchRow[] };
    const pendingMatches = pendingGiftMatches(pendingInputs, pending.results).map((match) => ({ fingerprint: match.fingerprint, candidates: match.candidates.map((candidate) => ({ id: candidate.id, activityDate: candidate.activity_date, amountCents: candidate.committed_cents, designation: candidate.description, note: candidate.private_note })) }));
    return Response.json({ profile: "jl-donations", donation: {
      rows: rows.length,
      matchedRows: compactPaymentExport ? paymentAssignments.filter((candidate) => candidate.donorId).length : match.matched.length,
      unknownHousehold: compactPaymentExport ? paymentAssignments.filter((candidate) => !candidate.donorId).length : match.unknownHousehold,
      duplicateSourceRows: donationPreview.duplicateRows.length,
      zeroDollar: donationPreview.counts.zeroDollar,
      openPledges: compactPaymentExport ? openPledges.results.length : donationPreview.counts.open_pledge + donationPreview.counts.partially_paid_pledge,
      needsReview: compactPaymentExport ? paymentAssignments.filter((candidate) => !candidate.alreadyApplied).length : match.needsReview,
      suspiciousDates: donationPreview.counts.suspiciousDates,
      nonfinancial: match.nonfinancial,
      newActivities: match.newActivities.length,
      proposedUpdates: match.proposedUpdates.length,
      alreadyImported: match.alreadyImported + paymentAssignments.filter((candidate) => candidate.alreadyApplied).length,
      conflicts: compactPaymentExport ? paymentAssignments.filter((candidate) => !candidate.alreadyApplied).length : match.unknownHousehold + match.needsReview,
      reviewRows: match.reviewActivities.map((activity) => ({ row: activity.rowNumber, reason: activity.reviewReason ?? "Row requires review" })),
      rejectedRows: donationPreview.duplicateRows.length + match.unknownHousehold + match.nonfinancial,
      rangeStart: isoDate(range.start),
      rangeEnd: isoDate(range.end),
      paymentAssignments: publicPaymentAssignments,
      pendingGiftMatches: pendingMatches,
    } });
  }
  const jlDetected = isJlSolutionsExport(columns);
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
