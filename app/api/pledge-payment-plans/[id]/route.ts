import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { validateInstallmentAmountCents, validatePlanNote, validateOriginalPledgeDate, validateCommitmentDurationMonths } from "../../../../lib/capture/pledge-payment-plan";
import { dayOfMonthFromDateOnlyEpoch, evaluatePledgeRenewal } from "../../../../lib/relationships/pledge-payment-plan";
import { parseFinancialDate } from "../../../../lib/financial-date";
import { logger } from "../../../../lib/logger";

// Edit or end an existing payment plan. This route NEVER touches
// giving_activities/gifts/jl_payment_assignment_audits or any other JL
// financial data -- ending a plan means only "the fundraiser no longer
// expects this schedule," never "the pledge is closed/paid/cancelled".
type PlanRow = { id: string; donor_id: string; installment_amount_cents: number | null; expected_day_of_month: number; next_expected_payment_at: number; final_expected_payment_at: number; note: string | null; original_pledge_date: number | null; commitment_duration_months: number | null; ended_at: number | null; renewal_acknowledged_at: number | null };
type RequestBody = {
  ended?: boolean;
  // Mark Renewal Addressed (2026-10-09, see docs/AI-HANDOFF.md) -- a
  // third, independent action alongside `ended`/the plain edit below,
  // never combined with either in the same request. Means "the
  // fundraiser has addressed this plan's standing renewal follow-up,"
  // never "the donor renewed" -- see the handler's own doc comment.
  acknowledgeRenewal?: boolean;
  installmentAmountCents?: number | null;
  nextExpectedPaymentAt?: string;
  finalExpectedPaymentAt?: string;
  note?: string;
  // Pledge Renewal Reminders, Part 1 (2026-10-08, see docs/AI-HANDOFF.md)
  // -- present+string sets it, present+null clears it, absent leaves it
  // unchanged (same Object.hasOwn-gated convention as every other
  // optional field below).
  originalPledgeDate?: string | null;
  // Pledge Renewal Reminders, commitment-duration correction (2026-10-08,
  // see docs/AI-HANDOFF.md) -- same present-sets/present-null-clears/
  // absent-unchanged convention as originalPledgeDate above.
  commitmentDurationMonths?: number | null;
};

async function ownedActivePlan(id: string, userId: string) {
  return env.DB.prepare(`SELECT p.id, p.donor_id, p.installment_amount_cents, p.expected_day_of_month, p.next_expected_payment_at, p.final_expected_payment_at, p.note, p.original_pledge_date, p.commitment_duration_months, p.ended_at, p.renewal_acknowledged_at
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

  // MARK RENEWAL ADDRESSED (2026-10-09, see docs/AI-HANDOFF.md). Sets
  // renewal_acknowledged_at ONLY -- never ended_at, never
  // originalPledgeDate/commitmentDurationMonths/the schedule fields,
  // never any giving_activities/gifts/jl_payment_assignment_audits row.
  // Scoped to this exact plan row (WHERE id = ? AND user_id = ?) --
  // acknowledging one plan can never affect a donor's other plans. Not
  // combined with `ended`/a plain edit in the same request, matching
  // the END branch's own convention above.
  if (body.acknowledgeRenewal === true) {
    if (plan.original_pledge_date === null || plan.commitment_duration_months === null) {
      return Response.json({ error: "This plan has no verified renewal date to acknowledge." }, { status: 422 });
    }
    // Duplicate-safety (2026-10-09, reviewed per independent-review
    // feedback on commit 3ff780c): a repeated/retried/double-clicked
    // request against an ALREADY-acknowledged plan is a safe,
    // idempotent no-op -- it returns the existing acknowledgment
    // unchanged rather than writing a second `pledge_payment_plan_changes`
    // row, which would otherwise read as two separate, misleading
    // acknowledgment events in the audit trail for what was really one
    // fundraiser action.
    if (plan.renewal_acknowledged_at !== null) {
      return Response.json({ planId: id, renewalAcknowledgedAt: plan.renewal_acknowledged_at, alreadyAcknowledged: true });
    }
    // SAFEGUARD (2026-10-09, independent-review requirement on commit
    // 3ff780c): never trust the client/UI alone that this plan
    // currently has an outstanding renewal follow-up -- the donor-page
    // button's own visibility is a convenience, never the authority.
    // Independently re-derive eligibility here, server-side, from this
    // plan's own current stored fields, using the EXACT SAME
    // evaluatePledgeRenewal the donor page/Today/Daily Agenda already
    // use -- so a request sent after the button should have
    // disappeared (date not yet reached, or the plan was edited/ended
    // out from under it) is rejected, never silently accepted.
    const evaluation = evaluatePledgeRenewal(plan.original_pledge_date, plan.commitment_duration_months, plan.ended_at, plan.renewal_acknowledged_at, now, profile.timezone);
    if (!evaluation.isRenewalFollowUpNeeded) {
      return Response.json({ error: "This plan does not currently have an outstanding renewal follow-up to acknowledge." }, { status: 422 });
    }
    const before = { renewalAcknowledgedAt: null };
    const after = { renewalAcknowledgedAt: now };
    const statements = [
      env.DB.prepare("UPDATE pledge_payment_plans SET renewal_acknowledged_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now, now, id, userId),
      env.DB.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'updated', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, userId, plan.donor_id, JSON.stringify(["renewalAcknowledgedAt"]), JSON.stringify(before), JSON.stringify(after), now),
    ];
    try { await env.DB.batch(statements); }
    catch (error) { logger.error("pledge_payment_plan_renewal_acknowledge_failed", error, { planId: id, userId }); return Response.json({ error: "The renewal follow-up could not be acknowledged" }, { status: 500 }); }
    logger.info("pledge_payment_plan_renewal_acknowledged", { planId: id, donorId: plan.donor_id, userId });
    return Response.json({ planId: id, renewalAcknowledgedAt: now });
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

  // Pledge Renewal Reminders, Part 1 (2026-10-08, see docs/AI-HANDOFF.md).
  // Object.hasOwn gates "field absent, leave unchanged" apart from
  // "field explicitly null, clear it" -- validateOriginalPledgeDate
  // itself treats undefined/null identically (see its own doc comment),
  // so that distinction belongs here, matching every other optional
  // field in this route.
  const originalPledgeDateProvided = Object.hasOwn(body, "originalPledgeDate");
  const originalPledgeDateResult = originalPledgeDateProvided ? validateOriginalPledgeDate(body.originalPledgeDate, now, profile.timezone) : { ok: true as const, originalPledgeDate: undefined as unknown as number | null };
  if (!originalPledgeDateResult.ok) return Response.json({ error: originalPledgeDateResult.reason }, { status: 422 });

  // Commitment-duration correction (2026-10-08, see docs/AI-HANDOFF.md) --
  // same Object.hasOwn-gated contract as originalPledgeDate above.
  const commitmentDurationProvided = Object.hasOwn(body, "commitmentDurationMonths");
  const commitmentDurationResult = commitmentDurationProvided ? validateCommitmentDurationMonths(body.commitmentDurationMonths) : { ok: true as const, commitmentDurationMonths: undefined as unknown as number | null };
  if (!commitmentDurationResult.ok) return Response.json({ error: commitmentDurationResult.reason }, { status: 422 });

  const nextInstallmentAmountCents = installmentProvided ? installment.amountCents : plan.installment_amount_cents;
  const nextNote = noteProvided ? noteResult.note : plan.note;
  const nextNextExpectedPaymentAt = nextExpectedProvided ? nextExpectedPaymentAt! : plan.next_expected_payment_at;
  const nextFinalExpectedPaymentAt = finalExpectedProvided ? finalExpectedPaymentAt! : plan.final_expected_payment_at;
  if (nextFinalExpectedPaymentAt < nextNextExpectedPaymentAt) return Response.json({ error: "Final expected payment date must be on or after the next expected payment date" }, { status: 422 });
  const nextExpectedDayOfMonth = nextExpectedProvided ? dayOfMonthFromDateOnlyEpoch(nextNextExpectedPaymentAt) : plan.expected_day_of_month;
  const nextOriginalPledgeDate = originalPledgeDateProvided ? originalPledgeDateResult.originalPledgeDate : plan.original_pledge_date;
  const nextCommitmentDurationMonths = commitmentDurationProvided ? commitmentDurationResult.commitmentDurationMonths : plan.commitment_duration_months;

  const changedFields: string[] = [];
  if (nextInstallmentAmountCents !== plan.installment_amount_cents) changedFields.push("installmentAmountCents");
  if (nextNote !== plan.note) changedFields.push("note");
  if (nextNextExpectedPaymentAt !== plan.next_expected_payment_at) { changedFields.push("nextExpectedPaymentAt"); changedFields.push("expectedDayOfMonth"); }
  if (nextFinalExpectedPaymentAt !== plan.final_expected_payment_at) changedFields.push("finalExpectedPaymentAt");
  const renewalDateInputsChanged = nextOriginalPledgeDate !== plan.original_pledge_date || nextCommitmentDurationMonths !== plan.commitment_duration_months;
  if (nextOriginalPledgeDate !== plan.original_pledge_date) changedFields.push("originalPledgeDate");
  if (nextCommitmentDurationMonths !== plan.commitment_duration_months) changedFields.push("commitmentDurationMonths");
  // SAFEGUARD (2026-10-09, independent-review requirement on commit
  // 3ff780c): editing EITHER field the renewal date is actually
  // computed from invalidates any existing acknowledgment -- the
  // acknowledgment was made against the OLD renewal date; silently
  // carrying it forward onto a materially recalculated date (which
  // could land anywhere: earlier, later, or not yet reached at all)
  // would risk permanently suppressing a genuinely different future
  // follow-up the fundraiser never actually addressed. Clearing it here
  // is the safe default -- the fundraiser simply re-acknowledges if the
  // new date still turns out not to need one. Never triggered by
  // editing any OTHER field (installment amount, note, the schedule
  // dates) -- none of those feed evaluatePledgeRenewal at all.
  const nextRenewalAcknowledgedAt = renewalDateInputsChanged ? null : plan.renewal_acknowledged_at;
  if (nextRenewalAcknowledgedAt !== plan.renewal_acknowledged_at) changedFields.push("renewalAcknowledgedAt");
  if (changedFields.length === 0) {
    return Response.json({ planId: id, donorId: plan.donor_id, installmentAmountCents: plan.installment_amount_cents, nextExpectedPaymentAt: plan.next_expected_payment_at, finalExpectedPaymentAt: plan.final_expected_payment_at, note: plan.note, originalPledgeDate: plan.original_pledge_date, commitmentDurationMonths: plan.commitment_duration_months, renewalAcknowledgedAt: plan.renewal_acknowledged_at, message: "No changes were needed." });
  }

  const before = { installmentAmountCents: plan.installment_amount_cents, expectedDayOfMonth: plan.expected_day_of_month, nextExpectedPaymentAt: plan.next_expected_payment_at, finalExpectedPaymentAt: plan.final_expected_payment_at, note: plan.note, originalPledgeDate: plan.original_pledge_date, commitmentDurationMonths: plan.commitment_duration_months, renewalAcknowledgedAt: plan.renewal_acknowledged_at };
  const after = { installmentAmountCents: nextInstallmentAmountCents, expectedDayOfMonth: nextExpectedDayOfMonth, nextExpectedPaymentAt: nextNextExpectedPaymentAt, finalExpectedPaymentAt: nextFinalExpectedPaymentAt, note: nextNote, originalPledgeDate: nextOriginalPledgeDate, commitmentDurationMonths: nextCommitmentDurationMonths, renewalAcknowledgedAt: nextRenewalAcknowledgedAt };

  const statements = [
    env.DB.prepare(`UPDATE pledge_payment_plans SET installment_amount_cents = ?, expected_day_of_month = ?, next_expected_payment_at = ?, final_expected_payment_at = ?, note = ?, original_pledge_date = ?, commitment_duration_months = ?, renewal_acknowledged_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(nextInstallmentAmountCents, nextExpectedDayOfMonth, nextNextExpectedPaymentAt, nextFinalExpectedPaymentAt, nextNote, nextOriginalPledgeDate, nextCommitmentDurationMonths, nextRenewalAcknowledgedAt, now, id, userId),
    env.DB.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'updated', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, userId, plan.donor_id, JSON.stringify(changedFields), JSON.stringify(before), JSON.stringify(after), now),
  ];

  try { await env.DB.batch(statements); }
  catch (error) { logger.error("pledge_payment_plan_update_failed", error, { planId: id, userId }); return Response.json({ error: "Payment plan could not be updated" }, { status: 500 }); }

  logger.info("pledge_payment_plan_updated", { planId: id, donorId: plan.donor_id, userId, changedFieldCount: changedFields.length });
  return Response.json({ planId: id, donorId: plan.donor_id, installmentAmountCents: nextInstallmentAmountCents, nextExpectedPaymentAt: nextNextExpectedPaymentAt, finalExpectedPaymentAt: nextFinalExpectedPaymentAt, note: nextNote, originalPledgeDate: nextOriginalPledgeDate, commitmentDurationMonths: nextCommitmentDurationMonths, renewalAcknowledgedAt: nextRenewalAcknowledgedAt, changedFields });
}
