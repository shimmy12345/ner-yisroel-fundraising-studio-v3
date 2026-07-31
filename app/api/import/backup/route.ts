import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";
import { ensureUserProfile } from "../../../../lib/auth/profile";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);

  try {
    const [donors, gifts, givingActivities, interactions, recommendations] = await Promise.all([
      env.DB.prepare("SELECT * FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample' ORDER BY id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM gifts WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY received_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM giving_activities WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY activity_date, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM interactions WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY occurred_at, id").bind(profile.id).all(),
      env.DB.prepare("SELECT * FROM recommendations WHERE donor_id IN (SELECT id FROM donors WHERE (owner_user_id = ? AND data_source = 'live') OR data_source = 'sample') ORDER BY created_at, id").bind(profile.id).all(),
    ]);
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      format: "fundraising-os-d1-backup-v1",
      donors: donors.results,
      gifts: gifts.results,
      givingActivities: givingActivities.results,
      interactions: interactions.results,
      remindersAndNextActions: recommendations.results,
    }, null, 2);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(payload, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="fundraising-os-backup-${date}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logger.error("import_backup_failed", error, { userId: profile.id });
    return Response.json({ error: "Backup could not be created" }, { status: 500 });
  }
}
