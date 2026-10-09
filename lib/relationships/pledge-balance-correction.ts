// Manual Pledge Balance Corrections (see docs/AI-HANDOFF.md) -- a
// controlled, auditable exception mechanism for the rare case where a
// real-world JL error has already been corrected but the correction
// never reached the spreadsheet FOS imports from (the real Shlomo
// Kutoff / DIN2023 case). Never a new payment, never a replacement for
// the JL import process, never an overwrite of
// giving_activities.balance_cents (the real imported figure) --
// correction rows live entirely in their own table
// (pledge_balance_corrections, migration 0042) and the EFFECTIVE
// balance is always DERIVED fresh from the two, never stored as a
// third, independent value.
//
// This file is the one, single, canonical statement of the
// effective-balance rule. The handful of SQL queries across the app
// that read giving_activities.balance_cents for display/evaluation
// (see docs/AI-HANDOFF.md's own consumer map) each realize this EXACT
// SAME rule directly in SQL, via `LEFT JOIN pledge_balance_corrections
// ... AND reversed_at IS NULL` + `COALESCE(corrected_balance_cents,
// balance_cents) AS balance_cents` -- never a second, divergent
// calculation. This TypeScript function exists for the few call sites
// that genuinely need the rule applied in memory (the correction
// management UI's own "current effective balance" display, which must
// show the imported and corrected values side by side) and as the one
// place this rule's own behavior is unit-tested.
export function effectiveBalanceCents(importedBalanceCents: number, activeCorrectedBalanceCents: number | null): number {
  return activeCorrectedBalanceCents !== null ? activeCorrectedBalanceCents : importedBalanceCents;
}

export type PledgeBalanceCorrectionRow = {
  id: string;
  pledgeActivityId: string;
  importedBalanceCentsAtCorrection: number;
  correctedBalanceCents: number;
  reason: string;
  createdAt: number;
  reversedAt: number | null;
  reversalReason: string | null;
};

// The currently ACTIVE correction for a pledge, if any -- exactly one
// row can ever satisfy this (enforced at the database level by
// migration 0042's partial unique index on
// (pledge_activity_id) WHERE reversed_at IS NULL), so this never has to
// choose among candidates; it only has to find the (at most one) row
// that qualifies.
export function activeCorrection(corrections: PledgeBalanceCorrectionRow[]): PledgeBalanceCorrectionRow | null {
  return corrections.find((c) => c.reversedAt === null) ?? null;
}

export const MAX_BALANCE_CORRECTION_REASON_LENGTH = 2000;

export type BalanceCorrectionValidation = { ok: true; correctedBalanceCents: number; reason: string } | { ok: false; reason: string };

// Requirement: do not allow invalid amounts, negative balances, or a
// blank reason. `correctedBalanceCents` must already be a whole number
// of cents (never parsed from a dollar string here -- that conversion,
// like every other money input in this app, belongs to the capture
// layer/UI, not this pure validator).
export function validateBalanceCorrection(correctedBalanceCents: unknown, reason: unknown): BalanceCorrectionValidation {
  if (typeof correctedBalanceCents !== "number" || !Number.isInteger(correctedBalanceCents) || correctedBalanceCents < 0) {
    return { ok: false, reason: "Corrected balance must be a whole, non-negative dollar amount." };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, reason: "A written explanation is required before saving a balance correction." };
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_BALANCE_CORRECTION_REASON_LENGTH) {
    return { ok: false, reason: `Explanation is too long (max ${MAX_BALANCE_CORRECTION_REASON_LENGTH} characters).` };
  }
  return { ok: true, correctedBalanceCents, reason: trimmed };
}
