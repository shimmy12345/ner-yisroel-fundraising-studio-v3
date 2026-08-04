import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { pendingGiftInput } from "../../../../lib/giving/management";
import { logger } from "../../../../lib/logger";

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const input = pendingGiftInput(await request.json().catch(() => null));
  if (input.errors.length) return Response.json({ error: input.errors.join(" ") }, { status: 422 });
  const donor = await env.DB.prepare("SELECT id,external_id,donor_code FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(input.donorId, profile.id).first<{ id: string; external_id: string | null; donor_code: string | null }>();
  if (!donor) return Response.json({ error: "Choose an active donor from your workspace." }, { status: 422 });
  const id = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO giving_activities
        (id,owner_user_id,donor_id,external_source,external_household_id,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,item_type,description,source_campaign,category,record_origin,workspace_status,private_note,source_snapshot,created_at,updated_at)
        VALUES (?,?,?,'Fundraising OS',?,?,?,?,0,0,'Pending gift',?,?,'pending_gift','live','active',?,'{}',?,?)`)
        .bind(id, profile.id, donor.id, donor.external_id || donor.donor_code || donor.id, `pending:${id}`, input.activityDate, input.amountCents, input.designation || null, input.designation || null, input.note || null, now, now),
      env.DB.prepare(`INSERT INTO giving_activity_management_audits
        (id,user_id,activity_id,action,next_donor_id,next_status,next_note,created_at)
        VALUES (?,?,?,'pending_created',?,'active',?,?)`).bind(auditId, profile.id, id, donor.id, input.note || null, now),
    ]);
    logger.info("pending_gift_recorded", { activityId: id, userId: profile.id, donorId: donor.id, auditId });
    return Response.json({ activityId: id, auditId, message: "Pending gift recorded as unconfirmed." }, { status: 201 });
  } catch (error) {
    logger.error("pending_gift_failed", error, { userId: profile.id });
    return Response.json({ error: "The pending gift could not be recorded. No partial record was kept." }, { status: 500 });
  }
}
