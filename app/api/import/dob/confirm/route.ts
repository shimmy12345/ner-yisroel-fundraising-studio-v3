import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { validateDonorOwnBirthdayConfirmation, type DobDonorLookup, type DobExistingLookup } from "../../../../../lib/import/dob-pipeline.ts";
import type { DobWorkbookRow } from "../../../../../lib/import/dob-workbook.ts";
import { logger } from "../../../../../lib/logger";

// Persists exactly one fact: an existing birthday row the fundraiser has
// explicitly confirmed is the donor's own, where the row's month/day/year
// already exactly match the spreadsheet. The ONLY column this route may
// ever write is important_dates.relationship, set to "Donor" -- never
// person_name, month, day, year, source, or fingerprint. Every fact this
// route relies on is independently re-derived from real D1 state via the
// same classifyDobRow the preview/commit routes use, never trusted from
// the client: a client can submit a row/existingId pair, but cannot make
// this route write anything unless that pair genuinely, currently
// satisfies every precondition (donor code resolves to exactly one live
// donor, the row belongs to that donor, it is a birthday row, its
// month/day/year exactly match the submitted spreadsheet row, its
// relationship is currently blank, and its current classification is
// genuinely needs_review for identity reasons). If any of those facts
// changed since the row was last previewed, the request is rejected --
// never blindly applied.
type Body = { donorCode?: string; month?: number; day?: number; year?: number; existingId?: string };
type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null; primary_first_name: string | null };
type ExistingRow = { id: string; donor_id: string; person_name: string | null; relationship: string | null; month: number; day: number; year: number | null };

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Date of birth import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body || typeof body.donorCode !== "string" || typeof body.month !== "number" || typeof body.day !== "number" || typeof body.year !== "number" || typeof body.existingId !== "string") {
    return Response.json({ error: "Invalid confirmation request." }, { status: 422 });
  }
  const row: DobWorkbookRow = { rowNumber: 0, donorCode: body.donorCode, dobRaw: null, month: body.month, day: body.day, year: body.year, dateError: null };

  const donorRows = await env.DB.prepare("SELECT id, display_name, donor_code, external_id, primary_first_name FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
  const donorLookup: DobDonorLookup = new Map();
  for (const donorRow of donorRows.results) {
    const code = numericDonorCode({ donorCode: donorRow.donor_code, externalId: donorRow.external_id });
    if (!code) continue;
    if (!donorLookup.has(code)) donorLookup.set(code, []);
    donorLookup.get(code)!.push({ donorId: donorRow.id, donorName: donorRow.display_name, donorFirstName: donorRow.primary_first_name });
  }

  const existingRowsResult = await env.DB.prepare("SELECT id, donor_id, person_name, relationship, month, day, year FROM important_dates WHERE user_id=? AND type='birthday'").bind(profile.id).all<ExistingRow>();
  const existingLookup: DobExistingLookup = new Map();
  for (const existingRow of existingRowsResult.results) {
    if (!existingLookup.has(existingRow.donor_id)) existingLookup.set(existingRow.donor_id, []);
    existingLookup.get(existingRow.donor_id)!.push({ id: existingRow.id, personName: existingRow.person_name, relationship: existingRow.relationship, month: existingRow.month, day: existingRow.day, year: existingRow.year });
  }

  const validation = validateDonorOwnBirthdayConfirmation(row, body.existingId, donorLookup, existingLookup);
  if (!validation.ok) {
    return Response.json({ error: validation.reason }, { status: 422 });
  }

  const existing = existingLookup.get(validation.donorId)!.find((r) => r.id === validation.existingId)!;
  const before = { personName: existing.personName, relationship: existing.relationship, month: existing.month, day: existing.day, year: existing.year };
  const after = { personName: existing.personName, relationship: "Donor", month: existing.month, day: existing.day, year: existing.year, source: "import-dob-confirm", donorCode: body.donorCode };
  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE important_dates SET relationship='Donor', updated_at=? WHERE id=? AND user_id=?`)
        .bind(now, validation.existingId, profile.id),
      env.DB.prepare(`INSERT INTO important_date_changes (id, important_date_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at) VALUES (?,?,?,?,'updated',?,?,?,?)`)
        .bind(changeId, validation.existingId, validation.donorId, profile.id, JSON.stringify(["relationship"]), JSON.stringify(before), JSON.stringify(after), now),
    ]);
  } catch (error) {
    logger.error("dob_import_confirm_failed", error, { userId: profile.id, existingId: validation.existingId });
    return Response.json({ error: "The confirmation could not be saved. The previous record remains unchanged." }, { status: 500 });
  }

  logger.info("dob_import_confirmed", { userId: profile.id, existingId: validation.existingId, donorId: validation.donorId });
  return Response.json({ id: validation.existingId, message: "Confirmed as the donor's own birthday.", changedFields: ["relationship"] });
}
