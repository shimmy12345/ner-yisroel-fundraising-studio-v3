import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { validateBalanceCorrection } from "../../../lib/relationships/pledge-balance-correction";
import { logger } from "../../../lib/logger";

// Manual Pledge Balance Corrections (see docs/AI-HANDOFF.md). This
// route NEVER touches giving_activities/gifts/jl_payment_assignment_audits
// or any other JL-sourced financial data -- correcting a pledge's
// EFFECTIVE balance means only "FOS should treat this specific pledge
// as having this outstanding amount from now on," never a new payment,
// never a replacement for the JL import process, never a change to the
// real imported balance itself.
type RequestBody = { pledgeActivityId?: string; correctedBalanceCents?: unknown; reason?: unknown };
type PledgeRow = { id: string; donor_id: string; balance_cents: number | null };
type ActiveCorrectionRow = { id: string };

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const pledgeActivityId = body.pledgeActivityId ?? "";
  if (!pledgeActivityId) return Response.json({ error: "A pledge is required" }, { status: 422 });

  const validation = validateBalanceCorrection(body.correctedBalanceCents, body.reason);
  if (!validation.ok) return Response.json({ error: validation.reason }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;

  // Independently re-verified against this exact user's own live,
  // non-archived donor's own pledge -- never trusted from the request
  // body, so a correction can never end up attached to the wrong
  // donor's pledge, and never becomes a donor-wide override (requirement:
  // scoped to the specific pledge activity id only). Deliberately reads
  // the RAW giving_activities.balance_cents (no correction JOIN here) --
  // this route needs the true imported figure to snapshot it, not an
  // already-corrected value.
  const pledge = await env.DB.prepare(`SELECT ga.id, ga.donor_id, ga.balance_cents
    FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
    WHERE ga.id = ? AND ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
      AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL`)
    .bind(pledgeActivityId, userId, userId).first<PledgeRow>();
  if (!pledge) return Response.json({ error: "Pledge not found" }, { status: 404 });

  const now = Math.floor(Date.now() / 1000);
  const correctionId = crypto.randomUUID();
  const importedBalanceCents = pledge.balance_cents ?? 0;

  // Supersede any existing active correction (reverse it, then insert
  // the new one) rather than editing it in place -- every value ever
  // set is preserved exactly as entered, matching this app's own
  // append-only audit discipline (pledge_payment_plan_changes, etc.).
  const existingActive = await env.DB.prepare(`SELECT id FROM pledge_balance_corrections WHERE pledge_activity_id = ? AND user_id = ? AND reversed_at IS NULL`)
    .bind(pledgeActivityId, userId).first<ActiveCorrectionRow>();

  const statements = [];
  if (existingActive) {
    statements.push(
      env.DB.prepare(`UPDATE pledge_balance_corrections SET reversed_at = ?, reversal_reason = ? WHERE id = ? AND user_id = ? AND reversed_at IS NULL`)
        .bind(now, "Superseded by a new correction", existingActive.id, userId),
    );
  }
  statements.push(
    env.DB.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .bind(correctionId, userId, pledge.donor_id, pledgeActivityId, importedBalanceCents, validation.correctedBalanceCents, validation.reason, now),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // The partial unique index (migration 0042, one row per pledge
    // active at a time) is the DB-level guard against a concurrent
    // request racing this exact same pledge -- surfaced here as a
    // clear, actionable error rather than a silent overwrite or an
    // opaque 500 (requirement: concurrent/repeated corrections cannot
    // silently overwrite one another).
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint/i.test(message)) {
      logger.error("pledge_balance_correction_race", error, { pledgeActivityId, userId });
      return Response.json({ error: "Another correction was just applied to this pledge. Refresh and try again." }, { status: 409 });
    }
    logger.error("pledge_balance_correction_failed", error, { pledgeActivityId, userId });
    return Response.json({ error: "The balance correction could not be saved" }, { status: 500 });
  }

  logger.info("pledge_balance_correction_created", { correctionId, pledgeActivityId, donorId: pledge.donor_id, userId });
  return Response.json({
    id: correctionId,
    pledgeActivityId,
    importedBalanceCentsAtCorrection: importedBalanceCents,
    correctedBalanceCents: validation.correctedBalanceCents,
    reason: validation.reason,
    createdAt: now,
  });
}
