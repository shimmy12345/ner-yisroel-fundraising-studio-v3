import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { classifyDobRow, type DobDonorLookup, type DobExistingLookup } from "../../../../../lib/import/dob-pipeline.ts";
import type { DobWorkbookRow } from "../../../../../lib/import/dob-workbook.ts";
import { logger } from "../../../../../lib/logger";

// Writes only rows that independently re-classify server-side as
// ready_to_add or enrich_missing_year -- the client's own preview
// classification is never trusted as the basis for a write, only as a UI
// convenience. A row submitted as already_recorded, conflict,
// needs_review, unmatched, ambiguous, or invalid is always rejected here
// even if the client claims otherwise (stale preview, tampered request,
// or a race with another change since the preview was shown). Never
// touches interactions, recommendations, giving_activities, gifts,
// pledges, donor_historical_context, yahrtzeits, relationship_summary, or
// institutional_memory -- the only tables this route writes are
// important_dates and its own audit trail, important_date_changes.
type IncomingRow = DobWorkbookRow & {
  // Set only by the review UI's explicit "Confirm this is the donor's
  // birthday" action -- re-validated server-side against this donor's
  // real existing rows below, never trusted as submitted.
  confirmedExistingId?: string | null;
};
type Body = { rows?: IncomingRow[] };
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
    return Response.json({ error: "No rows were submitted." }, { status: 422 });
  }

  const donorRows = await env.DB.prepare("SELECT id, display_name, donor_code, external_id, primary_first_name FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
  const donorLookup: DobDonorLookup = new Map();
  for (const row of donorRows.results) {
    const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
    if (!code) continue;
    if (!donorLookup.has(code)) donorLookup.set(code, []);
    donorLookup.get(code)!.push({ donorId: row.id, donorName: row.display_name, donorFirstName: row.primary_first_name });
  }

  const existingRowsResult = await env.DB.prepare("SELECT id, donor_id, person_name, relationship, month, day, year FROM important_dates WHERE user_id=? AND type='birthday'").bind(profile.id).all<ExistingRow>();
  const existingLookup: DobExistingLookup = new Map();
  for (const row of existingRowsResult.results) {
    if (!existingLookup.has(row.donor_id)) existingLookup.set(row.donor_id, []);
    existingLookup.get(row.donor_id)!.push({ id: row.id, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year });
  }

  const statements = [];
  const rejected: Array<{ rowNumber: number; status: string; reason: string }> = [];
  let createdCount = 0;
  let enrichedCount = 0;

  const now = Math.floor(Date.now() / 1000);
  for (const row of body.rows) {
    const classification = classifyDobRow(row, donorLookup, existingLookup, row.confirmedExistingId ?? null);
    if (classification.status !== "ready_to_add" && classification.status !== "enrich_missing_year") {
      rejected.push({ rowNumber: row.rowNumber, status: classification.status, reason: classification.issues[0] ?? "This row is not eligible to be written." });
      continue;
    }
    const donorId = classification.matchedDonorId!;
    const personName = classification.donorFirstName!;
    const fingerprint = classification.fingerprint!;
    const changeId = crypto.randomUUID();
    // Provenance snapshot -- source, the spreadsheet donor code, and the
    // imported DOB -- captured in the audit row, never in a new live-row
    // column (see the migration: only `source` itself changes shape).
    const provenance = { source: "import-dob", donorCode: row.donorCode, dobImported: `${row.month}/${row.day}/${row.year}` };

    if (classification.status === "ready_to_add") {
      const id = crypto.randomUUID();
      const after = { type: "birthday", personName, relationship: "Donor", month: row.month, day: row.day, year: row.year, ...provenance };
      statements.push(env.DB.prepare(`INSERT INTO important_dates (id, donor_id, user_id, type, person_name, relationship, month, day, year, notes, source, fingerprint, created_at, updated_at)
        VALUES (?,?,?,'birthday',?,?,?,?,?,NULL,'import-dob',?,?,?)`)
        .bind(id, donorId, profile.id, personName, "Donor", row.month, row.day, row.year, fingerprint, now, now));
      statements.push(env.DB.prepare(`INSERT INTO important_date_changes (id, important_date_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at) VALUES (?,?,?,?,'created',?,NULL,?,?)`)
        .bind(changeId, id, donorId, profile.id, JSON.stringify(Object.keys(after)), JSON.stringify(after), now));
      createdCount++;
    } else {
      const existing = classification.existingBirthday!;
      // Only year (and, only when currently blank, relationship -- never
      // overwriting an existing non-blank value) actually change here.
      // person_name is never rewritten -- see the review-confirmation
      // design: "Yaakov" must never become "Yaakov Yisroel" merely
      // because the donor profile has a fuller first name.
      const nextRelationship = existing.relationship && existing.relationship.trim() ? existing.relationship : "Donor";
      const before = { year: existing.year, relationship: existing.relationship };
      const after = { year: row.year, relationship: nextRelationship, ...provenance };
      const changedFields = ["year", ...(nextRelationship !== existing.relationship ? ["relationship"] : [])];
      statements.push(env.DB.prepare(`UPDATE important_dates SET year=?, relationship=?, updated_at=? WHERE id=? AND user_id=?`)
        .bind(row.year, nextRelationship, now, existing.id, profile.id));
      statements.push(env.DB.prepare(`INSERT INTO important_date_changes (id, important_date_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at) VALUES (?,?,?,?,'updated',?,?,?,?)`)
        .bind(changeId, existing.id, donorId, profile.id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(after), now));
      enrichedCount++;
    }
  }

  if (statements.length === 0) return Response.json({ createdCount: 0, enrichedCount: 0, rejected });

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("dob_import_commit_failed", error, { userId: profile.id });
    return Response.json({ error: "The import could not be saved. No rows were written." }, { status: 500 });
  }
  logger.info("dob_import_committed", { userId: profile.id, createdCount, enrichedCount, rejectedCount: rejected.length });
  return Response.json({ createdCount, enrichedCount, rejected });
}
