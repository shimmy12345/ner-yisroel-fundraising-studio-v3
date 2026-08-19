// Shared, pure validation for Ask fields -- reused by every write path
// (direct creation, interaction-capture creation, status/edit updates) so
// the rules can never drift between them. No D1 access here.

export const MAX_ASK_PURPOSE_LENGTH = 200;
export const MAX_ASK_NOTE_LENGTH = 2000;

export type AmountValidation = { ok: true; amountCents: number | null } | { ok: false };

// Integer cents only -- never floating point. undefined/null both mean "no
// specific figure" (a legitimate ask, e.g. "asked him to support the
// dinner"); anything else must be a positive integer. Exactly 0 is
// rejected too -- there is no meaningful "asked for $0" distinct from "no
// amount," and allowing it risks a fake $0 display later.
export function validateAskAmountCents(value: unknown): AmountValidation {
  if (value === undefined || value === null) return { ok: true, amountCents: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { ok: false };
  return { ok: true, amountCents: value };
}

export function validateAskPurpose(value: string | undefined): { ok: true; purpose: string | null } | { ok: false } {
  const purpose = value?.trim() || null;
  if (purpose && purpose.length > MAX_ASK_PURPOSE_LENGTH) return { ok: false };
  return { ok: true, purpose };
}

export function validateAskNote(value: string | undefined): { ok: true; note: string | null } | { ok: false } {
  const note = value?.trim() || null;
  if (note && note.length > MAX_ASK_NOTE_LENGTH) return { ok: false };
  return { ok: true, note };
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

// One shared "what is this ask, in a few words" phrase, used identically
// by the reminder text created here, the Suggested Action candidate
// (recommendation-candidates.ts's openAskCandidate), and the donor-page/
// Meeting Brief display (askLine) -- so the same ask is never described
// two different ways across surfaces. Never says "$0" -- a null amount
// degrades to purpose-only or "pending" rather than a fake figure.
export function askDescriptor(amountCents: number | null, purpose: string | null): string {
  const amountLabel = amountCents !== null ? money(amountCents) : null;
  if (amountLabel && purpose) return `${amountLabel} ${purpose}`;
  return amountLabel ?? purpose ?? "pending";
}

// Short, direct action text for the reminder/Suggested Action tied to an
// ask -- same phrasing convention everywhere, kept in one place so it can
// never drift between the API routes and the recommendation engine.
export function askFollowUpAction(amountCents: number | null, purpose: string | null): string {
  return `Follow up on the ${askDescriptor(amountCents, purpose)} ask.`;
}

export type AskStatus = "pending" | "committed" | "declined" | "withdrawn";
export type AskCurrentState = { amountCents: number | null; purpose: string | null; status: AskStatus; note: string | null };
export type AskUpdateInput = { status?: AskStatus; amountCents?: number | null; purpose?: string | null; note?: string | null };
export type AskUpdatePlan =
  | { ok: false; httpStatus: number; error: string }
  | { ok: true; changed: false }
  | { ok: true; changed: true; changedFields: string[]; before: AskCurrentState; after: AskCurrentState; action: "status_changed" | "updated" };

// Only these three transitions are supported in Phase 1 -- always FROM
// pending, one-way. Reopening a committed/declined/withdrawn ask back to
// pending is deliberately not supported: no compelling existing pattern in
// this codebase reopens a terminal state (recommendations' own open/
// completed/dismissed statuses have no "reopen" either), and the task's
// own default is "no unless justified."
export const ASK_TERMINAL_STATUSES: ReadonlySet<AskStatus> = new Set(["committed", "declined", "withdrawn"]);

// Pure decision logic for PATCH /api/asks/[id] -- no D1 access, so it is
// directly unit-testable. Validates the requested change, enforces the
// one-way pending-only transition rule, requires a reason (via the
// existing `note` field) on withdrawal, and computes exactly which fields
// actually changed (never blindly re-writing unchanged values).
export function planAskUpdate(current: AskCurrentState, input: AskUpdateInput): AskUpdatePlan {
  if (input.status !== undefined && !ASK_TERMINAL_STATUSES.has(input.status)) {
    return { ok: false, httpStatus: 422, error: "Status must be one of: committed, declined, withdrawn" };
  }
  const amount = validateAskAmountCentsForPatch(input.amountCents);
  if (!amount.ok) return { ok: false, httpStatus: 422, error: "Amount must be a positive whole number of cents, or left blank" };
  const purposeProvided = input.purpose !== undefined;
  const purpose = purposeProvided ? (input.purpose?.trim() || null) : undefined;
  if (purpose && purpose.length > MAX_ASK_PURPOSE_LENGTH) return { ok: false, httpStatus: 422, error: `Purpose must be ${MAX_ASK_PURPOSE_LENGTH} characters or fewer` };
  const noteProvided = input.note !== undefined;
  const note = noteProvided ? (input.note?.trim() || null) : undefined;
  if (note && note.length > MAX_ASK_NOTE_LENGTH) return { ok: false, httpStatus: 422, error: `Note must be ${MAX_ASK_NOTE_LENGTH} characters or fewer` };
  // A withdrawal must carry an explanatory reason, at the application
  // layer -- stored in the existing `note` column, not a new one, per
  // design ("keep it narrow").
  if (input.status === "withdrawn" && !note) return { ok: false, httpStatus: 422, error: "A reason is required to stop pursuing an ask" };
  if (input.status === undefined && amount.amountCents === undefined && !purposeProvided && !noteProvided) {
    return { ok: false, httpStatus: 422, error: "No changes were provided" };
  }
  if (input.status !== undefined && current.status !== "pending") {
    return { ok: false, httpStatus: 409, error: `This ask is already ${current.status} and cannot be changed again` };
  }

  const nextAmountCents = amount.amountCents === undefined ? current.amountCents : amount.amountCents;
  const nextPurpose = purpose === undefined ? current.purpose : purpose;
  const nextStatus = input.status ?? current.status;
  const nextNote = note === undefined ? current.note : note;

  const changedFields: string[] = [];
  if (nextAmountCents !== current.amountCents) changedFields.push("amountCents");
  if (nextPurpose !== current.purpose) changedFields.push("purpose");
  if (nextStatus !== current.status) changedFields.push("status");
  if (nextNote !== current.note) changedFields.push("note");
  if (changedFields.length === 0) return { ok: true, changed: false };

  return {
    ok: true, changed: true, changedFields,
    before: current,
    after: { amountCents: nextAmountCents, purpose: nextPurpose, status: nextStatus, note: nextNote },
    action: changedFields.includes("status") ? "status_changed" : "updated",
  };
}

// PATCH-specific 3-way validation (undefined = not provided, keep
// existing; null = explicitly clear; number = new value) -- deliberately
// NOT validateAskAmountCents above, whose 2-way undefined/null-both-mean-
// null semantics fit creation, not a partial update.
function validateAskAmountCentsForPatch(value: unknown): { ok: true; amountCents: number | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, amountCents: undefined };
  if (value === null) return { ok: true, amountCents: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { ok: false };
  return { ok: true, amountCents: value };
}
