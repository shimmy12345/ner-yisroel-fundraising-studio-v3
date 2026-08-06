import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { deploymentEnvironment } from "../../../../lib/environment";
import { loadDataHealth } from "../../../../lib/data-health/read";
import { STAGING_RESET_CONFIRMATION, STAGING_RESET_ONBOARDING_TABLE, STAGING_RESET_TABLE_ORDER, authorizeStagingReset } from "../../../../lib/operations/staging-reset";
import { logger } from "../../../../lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  const authorization = authorizeStagingReset(deploymentEnvironment, identity?.email ?? null, env.STAGING_OWNER_EMAIL);
  if (!authorization.allowed) return Response.json({ error: authorization.error }, { status: authorization.status });

  const body = await request.json().catch(() => null) as { confirmation?: string } | null;
  if (body?.confirmation !== STAGING_RESET_CONFIRMATION) {
    return Response.json({ error: "Confirm the reset with the exact confirmation phrase." }, { status: 422 });
  }

  const profile = await ensureUserProfile(identity!);
  try {
    const statements = [...STAGING_RESET_TABLE_ORDER, STAGING_RESET_ONBOARDING_TABLE].map((table) => env.DB.prepare(`DELETE FROM "${table}"`));
    await env.DB.batch(statements);
    const report = await loadDataHealth(profile.id);
    logger.info("staging_independent_reset", { userId: profile.id });
    return Response.json({ report });
  } catch (error) {
    logger.error("staging_independent_reset_failed", error, { userId: profile.id });
    return Response.json({ error: "The reset could not be completed." }, { status: 500 });
  }
}
