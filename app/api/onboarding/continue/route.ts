import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";

export async function POST() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const userId = `user_${user.email.toLowerCase()}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, user.email, user.displayName, now, now),
      env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'demo', ?) ON CONFLICT(user_id) DO UPDATE SET sample_data_acknowledged = 1, data_mode = 'demo', updated_at = excluded.updated_at")
        .bind(userId, now),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    logger.error("onboarding_sample_continue_failed", error, { userId });
    return Response.json({ error: "Sample workspace could not be opened" }, { status: 500 });
  }
}
