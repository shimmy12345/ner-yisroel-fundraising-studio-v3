import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { changedContactFields, normalizeDonorContact, type DonorContactInput, type NormalizedDonorContact } from "../../../../lib/donors/contact";
import { logger } from "../../../../lib/logger";

type ContactRow = {
  id: string; display_name: string; primary_first_name: string | null; spouse: string | null; email: string | null; phone: string | null;
  home_phone: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null;
  country: string | null; contact_note: string | null; external_source: string | null; external_id: string | null; donor_code: string | null;
};

function rowContact(row: ContactRow): NormalizedDonorContact {
  return normalizeDonorContact({ householdName: row.display_name, primaryFirstName: row.primary_first_name ?? "", spouseName: row.spouse ?? "", email: row.email ?? "", mobilePhone: row.phone ?? "", homePhone: row.home_phone ?? "", address: row.address_line_1 ?? "", city: row.city ?? "", state: row.state ?? "", postalCode: row.postal_code ?? "", country: row.country ?? "", note: row.contact_note ?? "" }).contact;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { id } = await params;
  const existing = await env.DB.prepare(`SELECT id,display_name,primary_first_name,spouse,email,phone,home_phone,address_line_1,city,state,postal_code,country,contact_note,external_source,external_id,donor_code
    FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' LIMIT 1`).bind(id, profile.id).first<ContactRow>();
  if (!existing) return Response.json({ error: "Donor not found" }, { status: 404 });
  const body = await request.json().catch(() => null) as DonorContactInput | null;
  if (!body) return Response.json({ error: "Invalid donor request" }, { status: 400 });
  const { contact, errors, valid } = normalizeDonorContact(body);
  if (!valid) return Response.json({ error: "Review the highlighted contact details.", fieldErrors: errors }, { status: 422 });
  const before = rowContact(existing);
  const changedFields = changedContactFields(before, contact);
  if (!changedFields.length) return Response.json({ donorId: id, href: `/donors/${encodeURIComponent(id)}`, message: "No contact changes were needed.", changedFields: [] });

  const auditId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE donors SET display_name=?,primary_first_name=?,spouse=?,spouse_first_name=?,email=?,phone=?,home_phone=?,address=?,address_line_1=?,last_name=?,city=?,state=?,postal_code=?,country=?,contact_note=?,updated_at=?
        WHERE id=? AND owner_user_id=? AND data_source='live'`)
        .bind(contact.householdName, contact.primaryFirstName || null, contact.spouseName || null, contact.spouseName || null, contact.email || null, contact.mobilePhone || null, contact.homePhone || null, contact.address || null, contact.address || null, contact.lastName || null, contact.city || null, contact.state || null, contact.postalCode || null, contact.country || null, contact.note || null, now, id, profile.id),
      env.DB.prepare(`INSERT INTO donor_contact_audits (id,user_id,donor_id,action,changed_fields,before_json,after_json,created_at)
        VALUES (?,?,?,'updated',?,?,?,?)`).bind(auditId, profile.id, id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(contact), now),
    ]);
    logger.info("donor_contact_updated", { donorId: id, userId: profile.id, auditId, changedFieldCount: changedFields.length });
    return Response.json({ donorId: id, auditId, href: `/donors/${encodeURIComponent(id)}`, message: "Contact details updated.", changedFields });
  } catch (error) {
    logger.error("donor_contact_update_failed", error, { donorId: id, userId: profile.id });
    return Response.json({ error: "The contact changes could not be saved. The previous record remains unchanged." }, { status: 500 });
  }
}
