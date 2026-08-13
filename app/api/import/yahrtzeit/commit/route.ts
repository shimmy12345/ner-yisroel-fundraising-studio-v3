import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { buildYahrtzeitPreview, type YahrtzeitDonorLookup } from "../../../../../lib/import/yahrtzeit-pipeline.ts";
import type { YahrtzeitWorkbookRow } from "../../../../../lib/import/yahrtzeit-workbook.ts";
import { logger } from "../../../../../lib/logger";

// Writes only rows that independently re-validate server-side as
// canCommit -- the client's own computed preview is never trusted as the
// basis for a write, only as a UI convenience. Idempotent: fingerprint is
// donor + Hebrew month/day + deceased English name (see
// lib/import/yahrtzeit-fingerprint.ts), so re-uploading the same or a
// refreshed workbook updates existing rows in place rather than
// duplicating them -- and when an already-imported row's content hasn't
// actually changed, this route writes nothing for it at all (no UPDATE,
// no audit row), so a re-upload can never touch a record that doesn't
// need touching. Never touches giving_activities, gifts, interactions, or
// recommendations -- the only tables this route writes are yahrtzeits and
// its own audit trail, yahrtzeit_changes.
type IncomingRow = YahrtzeitWorkbookRow & {
  // Set by the review UI only when the fundraiser hand-corrected a
  // malformed deceasedNameHebrew value during review -- preserved as
  // provenance in the audit snapshot, never written to the live record
  // itself.
  originalDeceasedNameHebrew?: string | null;
};
type Body = { rows?: IncomingRow[] };
type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null };
type ExistingYahrtzeitRow = { id: string; deceased_name_english: string; deceased_name_hebrew: string | null; relationship: string; hebrew_month: string; hebrew_day: number; hebrew_year: number | null };

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Yahrtzeit import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.rows || !Array.isArray(body.rows) || body.rows.length === 0) {
    return Response.json({ error: "No rows were submitted." }, { status: 422 });
  }

  const donorRows = await env.DB.prepare("SELECT id, display_name, donor_code, external_id FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>();
  const lookup: YahrtzeitDonorLookup = new Map();
  for (const row of donorRows.results) {
    const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
    if (code) lookup.set(code, { donorId: row.id, donorName: row.display_name });
  }

  const now = Math.floor(Date.now() / 1000);
  const preview = buildYahrtzeitPreview(body.rows, lookup, profile.timezone, now);

  const originalHebrewNameByRow = new Map(body.rows.map((row) => [row.rowNumber, row.originalDeceasedNameHebrew ?? null]));
  const statements = [];
  const rejected: Array<{ rowNumber: number; reason: string }> = [];
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const row of preview) {
    if (!row.canCommit || !row.matchedDonorId || !row.hebrewMonth || row.hebrewDay === null || !row.deceasedNameEnglish || !row.fingerprint) {
      rejected.push({ rowNumber: row.rowNumber, reason: row.issues[0] ?? "This row could not be validated." });
      continue;
    }
    const existing = await env.DB.prepare("SELECT id, deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day, hebrew_year FROM yahrtzeits WHERE fingerprint=? AND user_id=?").bind(row.fingerprint, profile.id).first<ExistingYahrtzeitRow>();
    const changeId = crypto.randomUUID();
    const originalHebrewName = originalHebrewNameByRow.get(row.rowNumber) ?? null;
    // Provenance for a hand-corrected malformed Hebrew name -- the audit
    // trail remembers what the workbook actually said, never the live
    // record itself (see lib/import/yahrtzeit-workbook.ts's parser, which
    // is the only other place the raw value would otherwise be visible).
    const correctedFromWorkbookValue = originalHebrewName !== null && originalHebrewName !== row.deceasedNameHebrew ? originalHebrewName : undefined;
    const after = {
      deceasedNameEnglish: row.deceasedNameEnglish, deceasedNameHebrew: row.deceasedNameHebrew, relationship: row.relationship ?? "",
      hebrewMonth: row.hebrewMonth, hebrewDay: row.hebrewDay, hebrewYear: row.hebrewYear,
      ...(correctedFromWorkbookValue !== undefined ? { deceasedNameHebrewAsImported: correctedFromWorkbookValue } : {}),
    };
    if (existing) {
      const before = {
        deceasedNameEnglish: existing.deceased_name_english, deceasedNameHebrew: existing.deceased_name_hebrew, relationship: existing.relationship,
        hebrewMonth: existing.hebrew_month, hebrewDay: existing.hebrew_day, hebrewYear: existing.hebrew_year,
      };
      const changedFields = (Object.keys(before) as (keyof typeof before)[]).filter((key) => before[key] !== after[key]);
      if (changedFields.length === 0) {
        // Nothing actually changed -- an already-imported row from a
        // re-uploaded workbook must not be touched at all, not even an
        // updated_at bump.
        unchangedCount++;
        continue;
      }
      statements.push(env.DB.prepare(`UPDATE yahrtzeits SET deceased_name_english=?, deceased_name_hebrew=?, relationship=?, hebrew_month=?, hebrew_day=?, hebrew_year=?, source_donor_code=?, updated_at=?
        WHERE id=? AND user_id=?`)
        .bind(row.deceasedNameEnglish, row.deceasedNameHebrew, row.relationship ?? "", row.hebrewMonth, row.hebrewDay, row.hebrewYear, row.donorCode, now, existing.id, profile.id));
      statements.push(env.DB.prepare(`INSERT INTO yahrtzeit_changes (id, yahrtzeit_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at) VALUES (?,?,?,?,'updated',?,?,?,?)`)
        .bind(changeId, existing.id, row.matchedDonorId, profile.id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(after), now));
      updatedCount++;
    } else {
      const id = crypto.randomUUID();
      statements.push(env.DB.prepare(`INSERT INTO yahrtzeits (id, donor_id, user_id, deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day, hebrew_year, source, source_donor_code, fingerprint, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'import-yahrtzeit-workbook',?,?,?,?)`)
        .bind(id, row.matchedDonorId, profile.id, row.deceasedNameEnglish, row.deceasedNameHebrew, row.relationship ?? "", row.hebrewMonth, row.hebrewDay, row.hebrewYear, row.donorCode, row.fingerprint, now, now));
      statements.push(env.DB.prepare(`INSERT INTO yahrtzeit_changes (id, yahrtzeit_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at) VALUES (?,?,?,?,'created',?,NULL,?,?)`)
        .bind(changeId, id, row.matchedDonorId, profile.id, JSON.stringify(Object.keys(after)), JSON.stringify(after), now));
      createdCount++;
    }
  }

  if (statements.length === 0) return Response.json({ createdCount: 0, updatedCount: 0, unchangedCount, rejected });

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("yahrtzeit_import_commit_failed", error, { userId: profile.id });
    return Response.json({ error: "The import could not be saved. No rows were written." }, { status: 500 });
  }
  logger.info("yahrtzeit_import_committed", { userId: profile.id, createdCount, updatedCount, unchangedCount, rejectedCount: rejected.length });
  return Response.json({ createdCount, updatedCount, unchangedCount, rejected });
}
