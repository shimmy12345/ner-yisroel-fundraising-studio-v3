import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  try {
    const [donors, gifts, givingActivities, interactions, recommendations] = await Promise.all([
      env.DB.prepare("SELECT * FROM donors ORDER BY id").all(),
      env.DB.prepare("SELECT * FROM gifts ORDER BY received_at, id").all(),
      env.DB.prepare("SELECT * FROM giving_activities ORDER BY activity_date, id").all(),
      env.DB.prepare("SELECT * FROM interactions ORDER BY occurred_at, id").all(),
      env.DB.prepare("SELECT * FROM recommendations ORDER BY created_at, id").all(),
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
    logger.error("import_backup_failed", error, { userId: `user_${user.email.toLowerCase()}` });
    return Response.json({ error: "Backup could not be created" }, { status: 500 });
  }
}
