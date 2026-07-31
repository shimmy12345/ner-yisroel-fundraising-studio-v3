import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { buildImportPreview, type ColumnMapping, type ImportRow } from "../../../../lib/import/recognition";
import { buildJlPreview, isJlSolutionsExport } from "../../../../lib/import/jl-solutions";
import { matchJlDonors, type ExistingJlDonor } from "../../../../lib/import/jl-match";
import { buildJlDonationPreview, isJlDonationExport } from "../../../../lib/import/jl-donations";
import { matchJlDonationActivities, type ExistingGivingActivity, type MatchedHousehold } from "../../../../lib/import/jl-donation-match";
import { ensureUserProfile } from "../../../../lib/auth/profile";

type PreviewRequest = { rows?: ImportRow[]; mapping?: ColumnMapping; fileHash?: string };

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
    const donationPreview = await buildJlDonationPreview(rows);
    const codes = [...new Set(donationPreview.activities.map((activity) => activity.externalHouseholdId.toLowerCase()).filter(Boolean))];
    const fingerprints = donationPreview.activities.map((activity) => activity.fingerprint);
    const households = codes.length ? await env.DB.prepare(`SELECT id, external_id FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(codes)).all<MatchedHousehold>() : { results: [] as MatchedHousehold[] };
    const existing = fingerprints.length ? await env.DB.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category, source_snapshot FROM giving_activities WHERE owner_user_id = ? AND record_origin = 'live' AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(fingerprints)).all<ExistingGivingActivity>() : { results: [] as ExistingGivingActivity[] };
    const match = matchJlDonationActivities(donationPreview, households.results, existing.results);
    return Response.json({ profile: "jl-donations", donation: {
      rows: rows.length,
      matchedRows: match.matched.length,
      unknownHousehold: match.unknownHousehold,
      duplicateSourceRows: donationPreview.duplicateRows.length,
      zeroDollar: donationPreview.counts.zeroDollar,
      openPledges: donationPreview.counts.open_pledge + donationPreview.counts.partially_paid_pledge,
      needsReview: match.needsReview,
      suspiciousDates: donationPreview.counts.suspiciousDates,
      nonfinancial: match.nonfinancial,
      newActivities: match.newActivities.length,
      proposedUpdates: match.proposedUpdates.length,
      alreadyImported: match.alreadyImported,
    } });
  }
  const jlDetected = isJlSolutionsExport(columns);
  const preview = jlDetected ? buildJlPreview(rows, fileHash) : buildImportPreview(rows, body.mapping ?? {}, fileHash);
  if (!jlDetected) return Response.json({ profile: "general", preview });

  const codes = preview.donors.map((donor) => donor.donorCode?.toLowerCase()).filter(Boolean);
  const existing = codes.length
    ? await env.DB.prepare(`SELECT id, external_id, display_name, email, phone, address, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, alternate_mobile_phone, home_phone, address_line_1, city, state, postal_code, country, source_snapshot FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND external_source = 'JL Solutions' AND lower(external_id) IN (SELECT value FROM json_each(?))`).bind(profile.id, JSON.stringify(codes)).all<ExistingJlDonor>()
    : { results: [] as ExistingJlDonor[] };
  const matches = matchJlDonors(preview.donors, existing.results);
  const conflicts = matches.flatMap((match) => match.conflicts);
  return Response.json({
    profile: "jl-solutions",
    preview,
    jl: {
      households: preview.donors.length,
      newRelationships: matches.filter((match) => !match.existing).length,
      existingRelationships: matches.filter((match) => match.existing).length,
      recordsWithUpdates: matches.filter((match) => Object.keys(match.safeUpdates).length > 0).length,
      conflicts,
    },
  });
}
