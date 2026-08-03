import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { changedContactFields, normalizeDonorContact, type DonorContactInput } from "../../../lib/donors/contact";
import { logger } from "../../../lib/logger";

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as DonorContactInput | null;
  if (!body) return Response.json({ error: "Invalid donor request" }, { status: 400 });
  const { contact, errors, valid } = normalizeDonorContact(body);
  if (!valid) return Response.json({ error: "Review the highlighted contact details.", fieldErrors: errors }, { status: 422 });

  const donorId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const after = JSON.stringify(contact);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO donors
        (id,owner_user_id,data_source,display_name,email,phone,donor_code,spouse,address,external_source,external_id,last_name,primary_first_name,spouse_first_name,home_phone,address_line_1,city,state,postal_code,country,contact_note,created_at,updated_at)
        VALUES (?,?,'live',?,?,?,?,?,?,'Manual',NULL,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(donorId, profile.id, contact.householdName, contact.email || null, contact.mobilePhone || null, null, contact.spouseName || null, contact.address || null, contact.lastName || null, contact.primaryFirstName || null, contact.spouseName || null, contact.homePhone || null, contact.address || null, contact.city || null, contact.state || null, contact.postalCode || null, contact.country || null, contact.note || null, now, now),
      env.DB.prepare(`INSERT INTO donor_contact_audits (id,user_id,donor_id,action,changed_fields,before_json,after_json,created_at)
        VALUES (?,?,?,'created',?,NULL,?,?)`).bind(auditId, profile.id, donorId, JSON.stringify(changedContactFields(null, contact)), after, now),
      env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'live', ?) ON CONFLICT(user_id) DO UPDATE SET data_mode = 'live', updated_at = excluded.updated_at").bind(profile.id, now),
    ]);
    logger.info("manual_donor_created", { donorId, userId: profile.id, auditId });
    return Response.json({ donorId, auditId, href: `/donors/${encodeURIComponent(donorId)}`, message: "Donor contact created." }, { status: 201 });
  } catch (error) {
    logger.error("manual_donor_create_failed", error, { userId: profile.id });
    return Response.json({ error: "The donor could not be saved. No partial record was kept." }, { status: 500 });
  }
}
