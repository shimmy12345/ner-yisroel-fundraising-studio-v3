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
