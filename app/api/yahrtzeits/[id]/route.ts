import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { normalizeYahrtzeit, changedYahrtzeitFields, type NormalizedYahrtzeit, type YahrtzeitInput } from "../../../../lib/yahrtzeit/validation.ts";
import { yahrtzeitFingerprint } from "../../../../lib/import/yahrtzeit-fingerprint.ts";
import { logger } from "../../../../lib/logger";

type Row = {
  id: string; donor_id: string; deceased_name_english: string; deceased_name_hebrew: string | null;
  relationship: string; hebrew_month: string; hebrew_day: number; hebrew_year: number | null;
};

function rowToNormalized(row: Row): NormalizedYahrtzeit {
  return {
    deceasedNameEnglish: row.deceased_name_english,
    deceasedNameHebrew: row.deceased_name_hebrew,
    relationship: row.relationship,
    hebrewMonth: row.hebrew_month as NormalizedYahrtzeit["hebrewMonth"],
    hebrewDay: row.hebrew_day,
    hebrewYear: row.hebrew_year,
  };
}

async function loadOwned(id: string, userId: string): Promise<Row | null> {
  return env.DB.prepare(`SELECT y.id, y.donor_id, y.deceased_name_english, y.deceased_name_hebrew, y.relationship, y.hebrew_month, y.hebrew_day, y.hebrew_year
    FROM yahrtzeits y JOIN donors d ON d.id = y.donor_id
    WHERE y.id=? AND y.user_id=? AND d.owner_user_id=? AND d.data_source='live' LIMIT 1`).bind(id, userId, userId).first<Row>();
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const existing = await loadOwned(id, profile.id);
  if (!existing) return Response.json({ error: "Yahrtzeit not found." }, { status: 404 });

  const body = await request.json().catch(() => null) as YahrtzeitInput | null;
  if (!body) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { normalized, errors, valid } = normalizeYahrtzeit(body);
  if (!valid || !normalized.hebrewMonth || normalized.hebrewDay === null) {
    return Response.json({ error: "Review the highlighted fields.", fieldErrors: errors }, { status: 422 });
  }

  const before = rowToNormalized(existing);
  const changedFields = changedYahrtzeitFields(before, normalized);
  if (!changedFields.length) return Response.json({ id, message: "No changes were needed.", changedFields: [] });

  const fingerprint = yahrtzeitFingerprint({ donorId: existing.donor_id, hebrewMonth: normalized.hebrewMonth, hebrewDay: normalized.hebrewDay, deceasedNameEnglish: normalized.deceasedNameEnglish });
  const conflict = await env.DB.prepare("SELECT id FROM yahrtzeits WHERE fingerprint=? AND id<>? LIMIT 1").bind(fingerprint, id).first<{ id: string }>();
  if (conflict) return Response.json({ error: "Another yahrtzeit record for this same person already exists on this donor." }, { status: 409 });

  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE yahrtzeits SET deceased_name_english=?, deceased_name_hebrew=?, relationship=?, hebrew_month=?, hebrew_day=?, hebrew_year=?, fingerprint=?, updated_at=?
        WHERE id=? AND user_id=?`)
        .bind(normalized.deceasedNameEnglish, normalized.deceasedNameHebrew, normalized.relationship, normalized.hebrewMonth, normalized.hebrewDay, normalized.hebrewYear, fingerprint, now, id, profile.id),
      env.DB.prepare(`INSERT INTO yahrtzeit_changes (id, yahrtzeit_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?,?,?,?,'updated',?,?,?,?)`)
        .bind(changeId, id, existing.donor_id, profile.id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(normalized), now),
    ]);
    logger.info("yahrtzeit_updated", { yahrtzeitId: id, userId: profile.id, changedFieldCount: changedFields.length });
    return Response.json({ id, message: "Yahrtzeit updated.", changedFields });
  } catch (error) {
    logger.error("yahrtzeit_update_failed", error, { yahrtzeitId: id, userId: profile.id });
    return Response.json({ error: "The yahrtzeit could not be saved. The previous record remains unchanged." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const existing = await loadOwned(id, profile.id);
  if (!existing) return Response.json({ error: "Yahrtzeit not found." }, { status: 404 });

  const before = rowToNormalized(existing);
  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM yahrtzeits WHERE id=? AND user_id=?").bind(id, profile.id),
      env.DB.prepare(`INSERT INTO yahrtzeit_changes (id, yahrtzeit_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?,?,?,?,'deleted',?,?,NULL,?)`)
        .bind(changeId, id, existing.donor_id, profile.id, JSON.stringify(Object.keys(before)), JSON.stringify(before), now),
    ]);
    logger.info("yahrtzeit_deleted", { yahrtzeitId: id, userId: profile.id });
    return Response.json({ id, message: "Yahrtzeit deleted." });
  } catch (error) {
    logger.error("yahrtzeit_delete_failed", error, { yahrtzeitId: id, userId: profile.id });
    return Response.json({ error: "The yahrtzeit could not be deleted." }, { status: 500 });
  }
}
