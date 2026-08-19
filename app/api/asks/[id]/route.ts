import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { planAskUpdate, type AskStatus, type AskUpdateInput } from "../../../../lib/capture/ask";
import { logger } from "../../../../lib/logger";

// Status transitions and amount/purpose/note edits for an existing ask.
// This route NEVER writes to giving_activities/gifts -- marking an ask
// 'committed' means only "the fundraiser recorded that the donor said
// yes"; it never creates, updates, or implies a real JL-recorded pledge
// or gift. See docs/ASK-SOLICITATION-DESIGN.md for the full boundary.
// The actual decision logic (validation, the one-way pending-only
// transition rule, changed-field computation) lives in the pure, unit-
// tested planAskUpdate() (lib/capture/ask.ts) -- this route is a thin
// wrapper around it plus the actual D1 write.
type AskRow = { id: string; donor_id: string; user_id: string; amount_cents: number | null; purpose: string | null; status: AskStatus; asked_at: number; note: string | null };

async function ownedAsk(id: string, userId: string) {
  return env.DB.prepare(`SELECT a.id, a.donor_id, a.user_id, a.amount_cents, a.purpose, a.status, a.asked_at, a.note
    FROM asks a JOIN donors d ON d.id = a.donor_id
    WHERE a.id = ? AND a.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`)
    .bind(id, userId, userId).first<AskRow>();
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;

  let body: AskUpdateInput;
  try { body = await request.json() as AskUpdateInput; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const ask = await ownedAsk(id, userId);
  if (!ask) return Response.json({ error: "Ask not found" }, { status: 404 });

  const plan = planAskUpdate({ amountCents: ask.amount_cents, purpose: ask.purpose, status: ask.status, note: ask.note }, body);
  if (!plan.ok) return Response.json({ error: plan.error }, { status: plan.httpStatus });
  if (!plan.changed) {
    return Response.json({ askId: id, donorId: ask.donor_id, amountCents: ask.amount_cents, purpose: ask.purpose, status: ask.status, note: ask.note, message: "No changes were needed." });
  }

  const now = Math.floor(Date.now() / 1000);
  const auditId = crypto.randomUUID();

  const statements = [
    env.DB.prepare("UPDATE asks SET amount_cents = ?, purpose = ?, status = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(plan.after.amountCents, plan.after.purpose, plan.after.status, plan.after.note, now, id, userId),
    env.DB.prepare(`INSERT INTO ask_changes (id, ask_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(auditId, id, userId, ask.donor_id, plan.action, JSON.stringify(plan.changedFields), JSON.stringify(plan.before), JSON.stringify(plan.after), now),
  ];

  // A status change ends this ask's active life -- every reminder still
  // open for it (id prefix "ask-<id>-", the same convention
  // app/api/asks/route.ts uses when creating one -- not a real FK,
  // recommendations has no ask_id column, matching interactions' own
  // "activity-<interactionId>" reminder-link convention) is completed
  // alongside it, covering every "Add follow-up" reminder ever set for
  // this ask, not just the first. No giving_activities/gifts write ever
  // happens here, regardless of the new status.
  if (plan.changedFields.includes("status")) {
    statements.push(
      env.DB.prepare("UPDATE recommendations SET status = 'completed', updated_at = ? WHERE user_id = ? AND status = 'open' AND id LIKE ? ESCAPE '\\'")
        .bind(now, userId, `ask-${id.replace(/[\\%_]/g, "\\$&")}-%`),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("ask_update_failed", error, { askId: id, userId });
    return Response.json({ error: "Ask could not be updated" }, { status: 500 });
  }

  logger.info("ask_updated", { askId: id, donorId: ask.donor_id, userId, changedFieldCount: plan.changedFields.length });
  return Response.json({ askId: id, donorId: ask.donor_id, amountCents: plan.after.amountCents, purpose: plan.after.purpose, status: plan.after.status, note: plan.after.note, changedFields: plan.changedFields });
}
