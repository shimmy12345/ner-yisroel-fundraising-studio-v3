import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { env } from "cloudflare:workers";
import { validHouseholdReviewMode } from "../../../lib/import/household-review";

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
function validTimezone(value: string) { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  return Response.json(await ensureUserProfile(identity));
}

export async function PUT(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const current = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid profile" }, { status: 400 });
  const fullName = text(body.fullName, 120), preferred = text(body.preferredFirstName, 60), organization = text(body.organizationName, 160), title = text(body.jobTitle, 120), timezone = text(body.timezone, 80), avatar = text(body.avatarUrl, 500);
  if (!fullName || !preferred || !organization || !validTimezone(timezone)) return Response.json({ error: "Full name, preferred name, organization, and a valid timezone are required" }, { status: 422 });
  if (avatar && !/^https:\/\//i.test(avatar)) return Response.json({ error: "Profile photo must use an HTTPS URL" }, { status: 422 });
  await env.DB.prepare("UPDATE users SET name = ?, preferred_first_name = ?, organization_name = ?, job_title = ?, timezone = ?, avatar_url = ?, updated_at = ? WHERE id = ?").bind(fullName, preferred, organization, title || null, timezone, avatar || null, Math.floor(Date.now() / 1000), current.id).run();
  return Response.json(await ensureUserProfile(identity));
}

export async function PATCH(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const current = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as { importReviewMode?: unknown } | null;
  if (!body || !validHouseholdReviewMode(body.importReviewMode)) return Response.json({ error: "Choose a valid import review mode" }, { status: 422 });
  await env.DB.prepare("UPDATE users SET household_import_review_mode = ?, updated_at = ? WHERE id = ?").bind(body.importReviewMode, Math.floor(Date.now() / 1000), current.id).run();
  return Response.json(await ensureUserProfile(identity));
}
