import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { loadWorkspaceBrief } from "../../../lib/workspace/live-data";
import { getDataMode } from "../../../lib/workspace/mode";
import { buildMorningBriefResponse } from "../../../lib/workspace/morning-brief-api";

// Plain-JSON morning-brief endpoint for trusted automation (e.g. a
// scheduled script) that cannot complete an interactive browser login.
// Auth: the same getChatGPTUser() every other API route in this app uses
// -- on Independent Staging that falls through to Cloudflare Access JWT
// verification, which now also accepts one specific, allow-listed Service
// Token (see lib/auth/cloudflare-access.ts's AccessVerifyConfig doc
// comment) as the SAME identity as the owner, never a separate one. This
// route adds no auth logic of its own and opens no new Access surface --
// it sits under the same Worker route Cloudflare Access already protects.
//
// Data: reuses loadWorkspaceBrief() -- the exact same function and query
// path Today (app/page.tsx) and the Assistant (app/api/assistant/route.ts)
// already call -- never a second, parallel brief computation. JSON
// reshaping itself is buildMorningBriefResponse() (lib/workspace/
// morning-brief-api.ts), a pure function, so it is directly unit-testable
// without a D1/env test harness.
export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const now = Math.floor(Date.now() / 1000);
  // Same default priority count Today's own un-expanded view uses (see
  // app/page.tsx's own loadWorkspaceBrief call) -- "the same data
  // currently shown," not a different, API-specific default.
  const brief = await loadWorkspaceBrief(profile.id, profile.timezone, mode, now, 10, "morning_brief_api");

  return Response.json(buildMorningBriefResponse(brief), { headers: { "cache-control": "no-store" } });
}
