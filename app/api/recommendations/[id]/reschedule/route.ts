import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";

// Same UTC-noon date-only anchor as the Monday commit route's own
// parseDateToEpochSeconds (app/api/import/monday/commit/route.ts) -- the
// established convention for "a calendar date with no real time of day"
// in this app, so localDayKey-based Due today/Overdue comparisons stay
// correct for every viewer timezone. Kept private here (not shared)
// rather than reused across the two routes, matching how each existing
// import/commit route already keeps its own private copy.
function parseDateOnly(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d), 12, 0, 0) / 1000;
}

// Mirrors ../complete/route.ts and ../dismiss/route.ts exactly for auth,
// ownership, and eligibility (status='open' only). Unlike those two, this
// route accepts a body -- but only ever writes due_at/due_at_date_only.
// action, reason (including any preserved "Imported from Monday ..."
// provenance), status, and donor_id are never touched, so a reschedule can
// never lose provenance, flip completion state, create a duplicate row, or
// touch interactions/giving_activities/gifts. Always date-only: the UI only
// ever collects a calendar date, never a time, so due_at_date_only is
// unconditionally set to 1 rather than guessing a time of day.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id } = await params;
  const body = await request.json().catch(() => null) as { dueDate?: string } | null;
  const dueAt = body?.dueDate ? parseDateOnly(body.dueDate) : null;
  if (dueAt === null) return Response.json({ error: "A valid due date is required" }, { status: 422 });
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`UPDATE recommendations
    SET due_at = ?, due_at_date_only = 1, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'open'
      AND donor_id IN (SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live')`)
    .bind(dueAt, now, id, profile.id, profile.id).run() as { meta: { changes?: number } };
  if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "Open reminder not found" }, { status: 404 });
  return Response.json({ dueAt });
}
