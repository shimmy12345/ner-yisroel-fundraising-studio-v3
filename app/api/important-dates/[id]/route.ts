import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { normalizeImportantDate, changedImportantDateFields, type NormalizedImportantDate, type ImportantDateInput } from "../../../../lib/important-dates/validation.ts";
import { importantDateFingerprint } from "../../../../lib/import/important-date-fingerprint.ts";
import { logger } from "../../../../lib/logger";

type Row = {
  id: string; donor_id: string; type: "birthday" | "anniversary"; person_name: string | null;
  relationship: string | null; month: number; day: number; year: number | null; notes: string | null;
};

function rowToNormalized(row: Row): NormalizedImportantDate {
  return { type: row.type, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year, notes: row.notes };
}

async function loadOwned(id: string, userId: string): Promise<Row | null> {
  return env.DB.prepare(`SELECT i.id, i.donor_id, i.type, i.person_name, i.relationship, i.month, i.day, i.year, i.notes
    FROM important_dates i JOIN donors d ON d.id = i.donor_id
    WHERE i.id=? AND i.user_id=? AND d.owner_user_id=? AND d.data_source='live' LIMIT 1`).bind(id, userId, userId).first<Row>();
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const existing = await loadOwned(id, profile.id);
  if (!existing) return Response.json({ error: "Important date not found." }, { status: 404 });

  const body = await request.json().catch(() => null) as ImportantDateInput | null;
  if (!body) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { normalized, errors, valid } = normalizeImportantDate(body);
  if (!valid || !normalized.type || normalized.month === null || normalized.day === null) {
    return Response.json({ error: "Review the highlighted fields.", fieldErrors: errors }, { status: 422 });
  }

  const before = rowToNormalized(existing);
  const changedFields = changedImportantDateFields(before, normalized);
  if (!changedFields.length) return Response.json({ id, message: "No changes were needed.", changedFields: [] });

  const fingerprint = importantDateFingerprint({ id, donorId: existing.donor_id, type: normalized.type, month: normalized.month, day: normalized.day, personName: normalized.personName });
  if (normalized.type === "birthday") {
    const conflict = await env.DB.prepare("SELECT id FROM important_dates WHERE fingerprint=? AND id<>? LIMIT 1").bind(fingerprint, id).first<{ id: string }>();
    if (conflict) return Response.json({ error: "Another birthday record for this same person already exists on this donor." }, { status: 409 });
  }

  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE important_dates SET type=?, person_name=?, relationship=?, month=?, day=?, year=?, notes=?, fingerprint=?, updated_at=?
        WHERE id=? AND user_id=?`)
        .bind(normalized.type, normalized.personName, normalized.relationship, normalized.month, normalized.day, normalized.year, normalized.notes, fingerprint, now, id, profile.id),
      env.DB.prepare(`INSERT INTO important_date_changes (id, important_date_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?,?,?,?,'updated',?,?,?,?)`)
        .bind(changeId, id, existing.donor_id, profile.id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(normalized), now),
    ]);
    logger.info("important_date_updated", { importantDateId: id, userId: profile.id, changedFieldCount: changedFields.length });
    return Response.json({ id, message: "Important date updated.", changedFields });
  } catch (error) {
    logger.error("important_date_update_failed", error, { importantDateId: id, userId: profile.id });
    return Response.json({ error: "The important date could not be saved. The previous record remains unchanged." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;

  const existing = await loadOwned(id, profile.id);
  if (!existing) return Response.json({ error: "Important date not found." }, { status: 404 });

  const before = rowToNormalized(existing);
  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM important_dates WHERE id=? AND user_id=?").bind(id, profile.id),
      env.DB.prepare(`INSERT INTO important_date_changes (id, important_date_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?,?,?,?,'deleted',?,?,NULL,?)`)
        .bind(changeId, id, existing.donor_id, profile.id, JSON.stringify(Object.keys(before)), JSON.stringify(before), now),
    ]);
    logger.info("important_date_deleted", { importantDateId: id, userId: profile.id });
    return Response.json({ id, message: "Important date deleted." });
  } catch (error) {
    logger.error("important_date_delete_failed", error, { importantDateId: id, userId: profile.id });
    return Response.json({ error: "The important date could not be deleted." }, { status: 500 });
  }
}
