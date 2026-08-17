import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { buildDobPreview, summarizeDobPreview, type DobDonorLookup, type DobExistingLookup } from "../../../../../lib/import/dob-pipeline.ts";
import type { DobWorkbookRow } from "../../../../../lib/import/dob-workbook.ts";
import { logger } from "../../../../../lib/logger";

// Same shape as the Yahrtzeit importer: the .xlsx itself is parsed
// client-side (parseDobWorkbook is isomorphic -- no Node-only APIs), so
// only the already-parsed rows travel over the wire. This route does the
// two things that have to happen server-side: matching Code against this
// owner's live donor records (exact match only), and reading existing
// Birthday important_dates rows to classify each row. Read-only --
// preview only, never writes.
type Body = { rows?: DobWorkbookRow[]; confirmations?: Array<{ rowNumber: number; existingId: string }> };
type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null; primary_first_name: string | null };
type ExistingRow = { id: string; donor_id: string; person_name: string | null; relationship: string | null; month: number; day: number; year: number | null };

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Date of birth import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.rows || !Array.isArray(body.rows) || body.rows.length === 0) {
    return Response.json({ error: "No rows were found in that file." }, { status: 422 });
  }

  try {
    const donors = await env.DB.prepare("SELECT id, display_name, donor_code, external_id, primary_first_name FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
    const donorLookup: DobDonorLookup = new Map();
    for (const row of donors.results) {
      const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
      if (!code) continue;
      const candidate = { donorId: row.id, donorName: row.display_name, donorFirstName: row.primary_first_name };
      if (!donorLookup.has(code)) donorLookup.set(code, []);
      donorLookup.get(code)!.push(candidate);
    }

    // Every existing Birthday row for this owner, grouped by donor --
    // includes spouse/child birthdays deliberately, so classifyDobRow can
    // tell "an unrelated birthday exists" apart from "no birthday exists
    // at all" rather than only ever seeing donor-own rows.
    const existingRows = await env.DB.prepare("SELECT id, donor_id, person_name, relationship, month, day, year FROM important_dates WHERE user_id=? AND type='birthday'").bind(profile.id).all<ExistingRow>();
    const existingLookup: DobExistingLookup = new Map();
    for (const row of existingRows.results) {
      if (!existingLookup.has(row.donor_id)) existingLookup.set(row.donor_id, []);
      existingLookup.get(row.donor_id)!.push({ id: row.id, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year });
    }

    const confirmedExistingIdByRow = new Map((body.confirmations ?? []).map((entry) => [entry.rowNumber, entry.existingId]));
    const preview = buildDobPreview(body.rows, donorLookup, existingLookup, confirmedExistingIdByRow);
    const summary = summarizeDobPreview(preview);
    logger.info("dob_import_previewed", { userId: profile.id, rowCount: preview.length, readyToAdd: summary.ready_to_add, alreadyRecorded: summary.already_recorded, enrichMissingYear: summary.enrich_missing_year, conflict: summary.conflict, needsReview: summary.needs_review, unmatched: summary.unmatched, ambiguous: summary.ambiguous, invalid: summary.invalid });
    return Response.json({ rows: preview, summary });
  } catch (error) {
    logger.error("dob_import_preview_failed", error, { userId: profile.id });
    return Response.json({ error: "That file could not be read as a Date of Birth workbook." }, { status: 422 });
  }
}
