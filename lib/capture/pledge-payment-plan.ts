// Pure, shared validation for pledge-payment-plan fundraiser input --
// reused by the create and edit routes so the rules can never drift
// between them. No D1 access here. Mirrors lib/capture/ask.ts's own
// shape exactly (this codebase's established house style for this kind
// of small, narrow, fundraiser-declared local record).

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
