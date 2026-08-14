import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { normalizeImportantDate, changedImportantDateFields, type ImportantDateInput } from "../../../../../lib/important-dates/validation.ts";
import { importantDateFingerprint } from "../../../../../lib/import/important-date-fingerprint.ts";
import { logger } from "../../../../../lib/logger";

// Manual "add an important date" entry (Birthday or Anniversary). Never
// touches interactions, giving, or donors.relationship_summary/
// institutional_memory -- like a yahrtzeit, this is background family
// context, not a logged contact.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id: donorId } = await params;

  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(donorId, profile.id).first<{ id: string }>();
  if (!donor) return Response.json({ error: "Donor not found." }, { status: 404 });

  const body = await request.json().catch(() => null) as ImportantDateInput | null;
  if (!body) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { normalized, errors, valid } = normalizeImportantDate(body);
  if (!valid || !normalized.type || normalized.month === null || normalized.day === null) {
    return Response.json({ error: "Review the highlighted fields.", fieldErrors: errors }, { status: 422 });
  }

  const id = crypto.randomUUID();
  const fingerprint = importantDateFingerprint({ id, donorId, type: normalized.type, month: normalized.month, day: normalized.day, personName: normalized.personName });
  if (normalized.type === "birthday") {
    const existing = await env.DB.prepare("SELECT id FROM important_dates WHERE fingerprint=? LIMIT 1").bind(fingerprint).first<{ id: string }>();
    if (existing) {
      return Response.json({ error: "A birthday for this person already exists on this donor. Edit the existing record instead.", existingId: existing.id }, { status: 409 });
    }
  }

  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const afterJson = JSON.stringify(normalized);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO important_dates (id, donor_id, user_id, type, person_name, relationship, month, day, year, notes, source, fingerprint, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'manual',?,?,?)`)
        .bind(id, donorId, profile.id, normalized.type, normalized.personName, normalized.relationship, normalized.month, normalized.day, normalized.year, normalized.notes, fingerprint, now, now),
      env.DB.prepare(`INSERT INTO important_date_changes (id, important_date_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?,?,?,?,'created',?,NULL,?,?)`)
        .bind(changeId, id, donorId, profile.id, JSON.stringify(changedImportantDateFields(null, normalized)), afterJson, now),
    ]);
    logger.info("important_date_created", { donorId, userId: profile.id, importantDateId: id, type: normalized.type });
    return Response.json({ id, href: `/donors/${encodeURIComponent(donorId)}` }, { status: 201 });
  } catch (error) {
    logger.error("important_date_create_failed", error, { donorId, userId: profile.id });
    return Response.json({ error: "The important date could not be saved." }, { status: 500 });
  }
}
