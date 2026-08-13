import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { normalizeYahrtzeit, changedYahrtzeitFields, type YahrtzeitInput } from "../../../../../lib/yahrtzeit/validation.ts";
import { yahrtzeitFingerprint } from "../../../../../lib/import/yahrtzeit-fingerprint.ts";
import { logger } from "../../../../../lib/logger";

// Manual "add a yahrtzeit" entry. Never touches interactions, giving, or
// donors.relationship_summary/institutional_memory -- a yahrtzeit is
// background family context, not a logged contact.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id: donorId } = await params;

  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(donorId, profile.id).first<{ id: string }>();
  if (!donor) return Response.json({ error: "Donor not found." }, { status: 404 });

  const body = await request.json().catch(() => null) as YahrtzeitInput | null;
  if (!body) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { normalized, errors, valid } = normalizeYahrtzeit(body);
  if (!valid || !normalized.hebrewMonth || normalized.hebrewDay === null) {
    return Response.json({ error: "Review the highlighted fields.", fieldErrors: errors }, { status: 422 });
  }

  const fingerprint = yahrtzeitFingerprint({ donorId, hebrewMonth: normalized.hebrewMonth, hebrewDay: normalized.hebrewDay, deceasedNameEnglish: normalized.deceasedNameEnglish });
  const existing = await env.DB.prepare("SELECT id FROM yahrtzeits WHERE fingerprint=? LIMIT 1").bind(fingerprint).first<{ id: string }>();
  if (existing) {
    return Response.json({ error: "A yahrtzeit for this person already exists on this donor. Edit the existing record instead.", existingId: existing.id }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const changeId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const afterJson = JSON.stringify(normalized);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO yahrtzeits (id, donor_id, user_id, deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day, hebrew_year, source, source_donor_code, fingerprint, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'manual',NULL,?,?,?)`)
        .bind(id, donorId, profile.id, normalized.deceasedNameEnglish, normalized.deceasedNameHebrew, normalized.relationship, normalized.hebrewMonth, normalized.hebrewDay, normalized.hebrewYear, fingerprint, now, now),
      env.DB.prepare(`INSERT INTO yahrtzeit_changes (id, yahrtzeit_id, donor_id, user_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?,?,?,?,'created',?,NULL,?,?)`)
        .bind(changeId, id, donorId, profile.id, JSON.stringify(changedYahrtzeitFields(null, normalized)), afterJson, now),
    ]);
    logger.info("yahrtzeit_created", { donorId, userId: profile.id, yahrtzeitId: id });
    return Response.json({ id, href: `/donors/${encodeURIComponent(donorId)}` }, { status: 201 });
  } catch (error) {
    logger.error("yahrtzeit_create_failed", error, { donorId, userId: profile.id });
    return Response.json({ error: "The yahrtzeit could not be saved." }, { status: 500 });
  }
}
