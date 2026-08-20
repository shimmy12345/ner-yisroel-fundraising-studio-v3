import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { validateInstallmentAmountCents, validatePlanNote } from "../../../../lib/capture/pledge-payment-plan";
import { dayOfMonthFromDateOnlyEpoch } from "../../../../lib/relationships/pledge-payment-plan";
import { parseFinancialDate } from "../../../../lib/financial-date";
import { logger } from "../../../../lib/logger";

// Edit or end an existing payment plan. This route NEVER touches
// giving_activities/gifts/jl_payment_assignment_audits or any other JL
// financial data -- ending a plan means only "the fundraiser no longer
// expects this schedule," never "the pledge is closed/paid/cancelled".
type PlanRow = { id: string; donor_id: string; installment_amount_cents: number | null; expected_day_of_month: number; next_expected_payment_at: number; final_expected_payment_at: number; note: string | null; ended_at: number | null };
type RequestBody = {
  ended?: boolean;
  installmentAmountCents?: number | null;
  nextExpectedPaymentAt?: string;
  finalExpectedPaymentAt?: string;
  note?: string;
};

async function ownedActivePlan(id: string, userId: string) {
  return env.DB.prepare(`SELECT p.id, p.donor_id, p.installment_amount_cents, p.expected_day_of_month, p.next_expected_payment_at, p.final_expected_payment_at, p.note, p.ended_at
    FROM pledge_payment_plans p
    WHERE p.id = ? AND p.user_id = ? LIMIT 1`)
    .bind(id, userId).first<PlanRow>();
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const plan = await ownedActivePlan(id, userId);
  if (!plan) return Response.json({ error: "Payment plan not found" }, { status: 404 });
  if (plan.ended_at !== null) return Response.json({ error: "This payment plan has already ended" }, { status: 409 });

  const now = Math.floor(Date.now() / 1000);

  // END: sets ended_at only. Never touches the pledge/balance/JL data.
  // Any edit fields present in the same request are ignored -- ending
  // and editing are never combined into one write.
  if (body.ended === true) {
    const noteResult = validatePlanNote(body.note);
    if (!noteResult.ok) return Response.json({ error: "Note is too long" }, { status: 422 });
    const before = { endedAt: null };
    const after = { endedAt: now, note: noteResult.note ?? plan.note };
    const statements = [
      env.DB.prepare("UPDATE pledge_payment_plans SET ended_at = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now, noteResult.note, now, id, userId),
      env.DB.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'ended', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, userId, plan.donor_id, JSON.stringify(noteResult.note !== null ? ["endedAt", "note"] : ["endedAt"]), JSON.stringify(before), JSON.stringify(after), now),
    ];
    try { await env.DB.batch(statements); }
    catch (error) { logger.error("pledge_payment_plan_end_failed", error, { planId: id, userId }); return Response.json({ error: "Payment plan could not be ended" }, { status: 500 }); }
    logger.info("pledge_payment_plan_ended", { planId: id, donorId: plan.donor_id, userId });
    return Response.json({ planId: id, endedAt: now });
  }

  // EDIT: partial update. Recomputes expected_day_of_month from a newly
  // entered nextExpectedPaymentAt -- never a separate input. Never
  // mutates actual payment history (jl_payment_assignment_audits) or the
  // pledge itself.
  const installmentProvided = Object.hasOwn(body, "installmentAmountCents");
  const installment = installmentProvided ? validateInstallmentAmountCents(body.installmentAmountCents) : { ok: true as const, amountCents: undefined as unknown as number | null };
  if (!installment.ok) return Response.json({ error: "Installment amount must be a positive whole number of cents, or left blank" }, { status: 422 });

  const noteProvided = Object.hasOwn(body, "note");
  const noteResult = noteProvided ? validatePlanNote(body.note) : { ok: true as const, note: undefined as unknown as string | null };
  if (!noteResult.ok) return Response.json({ error: "Note is too long" }, { status: 422 });

  const nextExpectedProvided = body.nextExpectedPaymentAt !== undefined;
  const nextExpectedPaymentAt = nextExpectedProvided ? parseFinancialDate(body.nextExpectedPaymentAt!) : undefined;
  if (nextExpectedProvided && nextExpectedPaymentAt === null) return Response.json({ error: "Next expected payment date is invalid" }, { status: 422 });

  const finalExpectedProvided = body.finalExpectedPaymentAt !== undefined;
  const finalExpectedPaymentAt = finalExpectedProvided ? parseFinancialDate(body.finalExpectedPaymentAt!) : undefined;
  if (finalExpectedProvided && finalExpectedPaymentAt === null) return Response.json({ error: "Final expected payment date is invalid" }, { status: 422 });

  const nextInstallmentAmountCents = installmentProvided ? installment.amountCents : plan.installment_amount_cents;
  const nextNote = noteProvided ? noteResult.note : plan.note;
  const nextNextExpectedPaymentAt = nextExpectedProvided ? nextExpectedPaymentAt! : plan.next_expected_payment_at;
  const nextFinalExpectedPaymentAt = finalExpectedProvided ? finalExpectedPaymentAt! : plan.final_expected_payment_at;
  if (nextFinalExpectedPaymentAt < nextNextExpectedPaymentAt) return Response.json({ error: "Final expected payment date must be on or after the next expected payment date" }, { status: 422 });
  const nextExpectedDayOfMonth = nextExpectedProvided ? dayOfMonthFromDateOnlyEpoch(nextNextExpectedPaymentAt) : plan.expected_day_of_month;

  const changedFields: string[] = [];
  if (nextInstallmentAmountCents !== plan.installment_amount_cents) changedFields.push("installmentAmountCents");
  if (nextNote !== plan.note) changedFields.push("note");
  if (nextNextExpectedPaymentAt !== plan.next_expected_payment_at) { changedFields.push("nextExpectedPaymentAt"); changedFields.push("expectedDayOfMonth"); }
  if (nextFinalExpectedPaymentAt !== plan.final_expected_payment_at) changedFields.push("finalExpectedPaymentAt");
  if (changedFields.length === 0) {
    return Response.json({ planId: id, donorId: plan.donor_id, installmentAmountCents: plan.installment_amount_cents, nextExpectedPaymentAt: plan.next_expected_payment_at, finalExpectedPaymentAt: plan.final_expected_payment_at, note: plan.note, message: "No changes were needed." });
  }

  const before = { installmentAmountCents: plan.installment_amount_cents, expectedDayOfMonth: plan.expected_day_of_month, nextExpectedPaymentAt: plan.next_expected_payment_at, finalExpectedPaymentAt: plan.final_expected_payment_at, note: plan.note };
  const after = { installmentAmountCents: nextInstallmentAmountCents, expectedDayOfMonth: nextExpectedDayOfMonth, nextExpectedPaymentAt: nextNextExpectedPaymentAt, finalExpectedPaymentAt: nextFinalExpectedPaymentAt, note: nextNote };

  const statements = [
    env.DB.prepare(`UPDATE pledge_payment_plans SET installment_amount_cents = ?, expected_day_of_month = ?, next_expected_payment_at = ?, final_expected_payment_at = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(nextInstallmentAmountCents, nextExpectedDayOfMonth, nextNextExpectedPaymentAt, nextFinalExpectedPaymentAt, nextNote, now, id, userId),
    env.DB.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'updated', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, userId, plan.donor_id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(after), now),
  ];

  try { await env.DB.batch(statements); }
  catch (error) { logger.error("pledge_payment_plan_update_failed", error, { planId: id, userId }); return Response.json({ error: "Payment plan could not be updated" }, { status: 500 }); }

  logger.info("pledge_payment_plan_updated", { planId: id, donorId: plan.donor_id, userId, changedFieldCount: changedFields.length });
  return Response.json({ planId: id, donorId: plan.donor_id, installmentAmountCents: nextInstallmentAmountCents, nextExpectedPaymentAt: nextNextExpectedPaymentAt, finalExpectedPaymentAt: nextFinalExpectedPaymentAt, note: nextNote, changedFields });
}
