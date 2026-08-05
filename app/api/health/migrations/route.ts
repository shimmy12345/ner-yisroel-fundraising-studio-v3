import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { readRemoteMigrationHistory } from "../../../../lib/data-health/remote-migrations";
import { logger } from "../../../../lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  try {
    const history = await readRemoteMigrationHistory(env.DB);
    return Response.json(history, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    logger.error("migration_history_read_failed", error, { userId: profile.id });
    return Response.json({ error: "Migration history could not be read." }, { status: 500 });
  }
}
