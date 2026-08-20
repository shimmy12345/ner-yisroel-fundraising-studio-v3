import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { validateInstallmentAmountCents, validatePlanNote } from "../../../lib/capture/pledge-payment-plan";
import { dayOfMonthFromDateOnlyEpoch } from "../../../lib/relationships/pledge-payment-plan";
import { parseFinancialDate } from "../../../lib/financial-date";
import { logger } from "../../../lib/logger";

// Attaches a payment plan to an EXISTING open JL pledge -- never creates
// a pledge, never modifies giving_activities/JL data of any kind.
// pledge_activity_id is trusted only after being independently
// re-verified against this exact user's own live donor's own open
// pledge (never taken on faith from the request body) -- this is what
// structurally prevents attaching a plan to another user's pledge or the
// wrong donor's pledge. expected_day_of_month is always derived here,
// server-side, from the fundraiser's own next-expected-payment date --
// never accepted as a separate input.
type RequestBody = {
  pledgeActivityId?: string;
  installmentAmountCents?: number | null;
  nextExpectedPaymentAt?: string;
  finalExpectedPaymentAt?: string;
  note?: string;
};

type PledgeRow = { id: string; donor_id: string; balance_cents: number | null };

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const pledgeActivityId = body.pledgeActivityId ?? "";
  if (!pledgeActivityId) return Response.json({ error: "A pledge is required" }, { status: 422 });

  const installment = validateInstallmentAmountCents(body.installmentAmountCents);
  if (!installment.ok) return Response.json({ error: "Installment amount must be a positive whole number of cents, or left blank" }, { status: 422 });

  const noteResult = validatePlanNote(body.note);
  if (!noteResult.ok) return Response.json({ error: "Note is too long" }, { status: 422 });

  const nextExpectedPaymentAt = body.nextExpectedPaymentAt ? parseFinancialDate(body.nextExpectedPaymentAt) : null;
  if (nextExpectedPaymentAt === null) return Response.json({ error: "A valid next expected payment date is required" }, { status: 422 });
  const finalExpectedPaymentAt = body.finalExpectedPaymentAt ? parseFinancialDate(body.finalExpectedPaymentAt) : null;
  if (finalExpectedPaymentAt === null) return Response.json({ error: "A valid final expected payment date is required" }, { status: 422 });
  if (finalExpectedPaymentAt < nextExpectedPaymentAt) return Response.json({ error: "Final expected payment date must be on or after the next expected payment date" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;

  // Independently re-verified: this exact pledge must belong to this
  // exact user, on a live (not archived/merged) donor they own, and
  // still be genuinely open (balance > 0). donor_id is read from THIS
  // row, never trusted from the request body -- so a plan can never end
  // up attached to the wrong donor.
  const pledge = await env.DB.prepare(`SELECT ga.id, ga.donor_id, ga.balance_cents
    FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
    WHERE ga.id = ? AND ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
      AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL`)
    .bind(pledgeActivityId, userId, userId).first<PledgeRow>();
  if (!pledge) return Response.json({ error: "Open pledge not found" }, { status: 404 });
  if ((pledge.balance_cents ?? 0) <= 0) return Response.json({ error: "This pledge has no open balance" }, { status: 422 });

  // One active plan per pledge -- application-level check (fresh read),
  // not a DB uniqueness constraint, so ended plans can coexist with a
  // later new one on the same pledge.
  const existingActive = await env.DB.prepare("SELECT id FROM pledge_payment_plans WHERE pledge_activity_id = ? AND ended_at IS NULL LIMIT 1")
    .bind(pledgeActivityId).first<{ id: string }>();
  if (existingActive) return Response.json({ error: "This pledge already has an active payment plan" }, { status: 409 });

  const expectedDayOfMonth = dayOfMonthFromDateOnlyEpoch(nextExpectedPaymentAt);
  const now = Math.floor(Date.now() / 1000);
  const planId = crypto.randomUUID();
  const afterJson = { installmentAmountCents: installment.amountCents, expectedDayOfMonth, nextExpectedPaymentAt, finalExpectedPaymentAt, note: noteResult.note };

  const statements = [
    env.DB.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, cadence, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'monthly', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(planId, userId, pledge.donor_id, pledgeActivityId, installment.amountCents, expectedDayOfMonth, nextExpectedPaymentAt, finalExpectedPaymentAt, noteResult.note, now, now),
    env.DB.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'created', ?, NULL, ?, ?)`)
      .bind(crypto.randomUUID(), planId, userId, pledge.donor_id, JSON.stringify(["installmentAmountCents", "expectedDayOfMonth", "nextExpectedPaymentAt", "finalExpectedPaymentAt", "note"]), JSON.stringify(afterJson), now),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("pledge_payment_plan_create_failed", error, { pledgeActivityId, userId });
    return Response.json({ error: "Payment plan could not be saved" }, { status: 500 });
  }

  logger.info("pledge_payment_plan_created", { planId, donorId: pledge.donor_id, pledgeActivityId, userId });
  return Response.json({ planId, donorId: pledge.donor_id, pledgeActivityId, installmentAmountCents: installment.amountCents, nextExpectedPaymentAt, finalExpectedPaymentAt, note: noteResult.note }, { status: 201 });
}
