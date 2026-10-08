// Pure, shared validation for pledge-payment-plan fundraiser input --
// reused by the create and edit routes so the rules can never drift
// between them. No D1 access here. Mirrors lib/capture/ask.ts's own
// shape exactly (this codebase's established house style for this kind
// of small, narrow, fundraiser-declared local record).

import { parseFinancialDate } from "../financial-date.ts";
import { localDateOnlyEpoch } from "../workspace/local-time.ts";

export const MAX_PLAN_NOTE_LENGTH = 2000;

export type AmountValidation = { ok: true; amountCents: number | null } | { ok: false };

// Descriptive only -- never inspected by the cycle-satisfaction/lateness
// logic (see lib/relationships/pledge-payment-plan.ts). Same integer-
// cents, positive-or-null semantics as validateAskAmountCents.
export function validateInstallmentAmountCents(value: unknown): AmountValidation {
  if (value === undefined || value === null) return { ok: true, amountCents: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { ok: false };
  return { ok: true, amountCents: value };
}

export function validatePlanNote(value: string | undefined): { ok: true; note: string | null } | { ok: false } {
  const note = value?.trim() || null;
  if (note && note.length > MAX_PLAN_NOTE_LENGTH) return { ok: false };
  return { ok: true, note };
}

export type OriginalPledgeDateValidation = { ok: true; originalPledgeDate: number | null } | { ok: false; reason: string };

// Annual Renewal Reminders, Part 1 (2026-10-08, see docs/AI-HANDOFF.md).
// `value` is the raw request field: `undefined`/`null` means "no date" --
// the SAME convention validateInstallmentAmountCents already uses above,
// so a create-route caller can pass this straight through, and an
// edit-route caller gates on `Object.hasOwn(body, "originalPledgeDate")`
// FIRST (same pattern as every other optional edit field in app/api/
// pledge-payment-plans/[id]/route.ts) to tell "field absent, leave
// unchanged" apart from "field explicitly null, clear it" -- that
// distinction belongs to the caller, not this validator. A string is
// parsed via the same date-only convention every other plan date uses
// (parseFinancialDate -- rejects impossible calendar dates structurally,
// e.g. Feb 30) and rejected if it falls after the fundraiser's own
// Eastern "today" (localDateOnlyEpoch(now, timezone) -- the same
// normalization the 2026-10-08 payment-plan timezone fix established,
// never a raw UTC comparison). Never defaults to today/now itself and
// never infers a date from anything else -- this field is populated
// ONLY from an explicit fundraiser entry, by product decision.
export function validateOriginalPledgeDate(value: string | null | undefined, now: number, timezone: string): OriginalPledgeDateValidation {
  if (value === undefined || value === null) return { ok: true, originalPledgeDate: null };
  const parsed = parseFinancialDate(value);
  if (parsed === null) return { ok: false, reason: "Original pledge date is invalid" };
  if (parsed > localDateOnlyEpoch(now, timezone)) return { ok: false, reason: "Original pledge date cannot be in the future" };
  return { ok: true, originalPledgeDate: parsed };
}

export type CommitmentDurationValidation = { ok: true; commitmentDurationMonths: number | null } | { ok: false; reason: string };

// Minimum 1 month (zero/negative is never a real commitment length);
// maximum 120 months (10 years) -- a documented, generous upper bound
// chosen only to catch fat-finger entry errors (e.g. "1200" typed for
// "12"), never a real product constraint on how long a commitment can
// run. Exported so the UI's own client-side bound (if any) and tests
// both reference the SAME single source, never a duplicated magic number.
export const MIN_COMMITMENT_DURATION_MONTHS = 1;
export const MAX_COMMITMENT_DURATION_MONTHS = 120;

// Pledge Renewal Reminders, commitment-duration correction (2026-10-08,
// see docs/AI-HANDOFF.md). Same `undefined`/`null` = "not yet verified"
// convention as validateOriginalPledgeDate above, same create/edit
// caller contract (edit route gates on Object.hasOwn(body,
// "commitmentDurationMonths") first). Accepts a plain whole number of
// months ONLY -- never a string to parse, never a derived value -- the
// UI's duration selector (6/12/18/24/Custom) always sends a number. Must
// be a strictly positive integer (no fractional months -- "18.5 months"
// is not a real commitment length and would make the calendar-month
// renewal-date arithmetic ambiguous) within
// [MIN_COMMITMENT_DURATION_MONTHS, MAX_COMMITMENT_DURATION_MONTHS].
// Never inferred from installment count, payment frequency, final
// expected payment date, campaign code, or balance -- this field is
// populated ONLY from an explicit fundraiser entry, by product decision,
// exactly like originalPledgeDate.
export function validateCommitmentDurationMonths(value: number | null | undefined): CommitmentDurationValidation {
  if (value === undefined || value === null) return { ok: true, commitmentDurationMonths: null };
  if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, reason: "Commitment duration must be a whole number of months" };
  if (value < MIN_COMMITMENT_DURATION_MONTHS || value > MAX_COMMITMENT_DURATION_MONTHS) return { ok: false, reason: `Commitment duration must be between ${MIN_COMMITMENT_DURATION_MONTHS} and ${MAX_COMMITMENT_DURATION_MONTHS} months` };
  return { ok: true, commitmentDurationMonths: value };
}

export type CustomDurationInputValidation = { ok: true; months: number } | { ok: false; reason: string };

// Custom-duration input-field correction (2026-10-08, see docs/AI-HANDOFF.md):
// PledgePaymentPlanManagement.tsx's "Custom…" duration field previously fed
// raw user text straight through Number.parseInt, which silently
// truncates instead of rejecting -- "9.5" became 9, "12abc" became 12,
// letting a fundraiser accidentally save and generate a renewal reminder
// on the wrong date. This function validates the ENTIRE raw string, never
// a partial/truncating parse: only a string of digits only (no sign, no
// decimal point, no letters, nothing but [0-9] once trimmed) is even
// considered a candidate whole number -- a fractional, negative, or
// garbage-suffixed value is rejected outright, never reinterpreted as
// something else. The actual range check then reuses the SAME
// validateCommitmentDurationMonths above that the server itself
// authoritatively enforces, so the client (PledgePaymentPlanManagement.tsx)
// can never accept a value the server would reject, and
// [MIN_COMMITMENT_DURATION_MONTHS, MAX_COMMITMENT_DURATION_MONTHS] is
// never duplicated as a second, driftable bound. Lives here (not in the
// "use client" component) so it is plain, directly testable TypeScript,
// matching every other validator in this file -- the component only
// imports and calls it.
export function validateCustomDurationInput(raw: string): CustomDurationInputValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: `Enter a whole number of months (${MIN_COMMITMENT_DURATION_MONTHS}-${MAX_COMMITMENT_DURATION_MONTHS}), or choose "Not set" to leave it unverified.` };
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: "Commitment duration must be a whole number of months -- no decimals, letters, or other characters." };
  const parsed = Number(trimmed);
  const result = validateCommitmentDurationMonths(parsed);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, months: parsed };
}
