import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { effectiveBalanceCents, activeCorrection, validateBalanceCorrection, MAX_BALANCE_CORRECTION_REASON_LENGTH } from "../lib/relationships/pledge-balance-correction.ts";

// Manual Pledge Balance Corrections (see docs/AI-HANDOFF.md) -- the
// real Shlomo Kutoff (57932) / DIN2023 case: a JL error was already
// corrected in JL, but the correction never reached the spreadsheet
// FOS imports from, so FOS still shows an outstanding balance that
// does not exist in reality. Pure-function coverage here; real,
// isolated end-to-end coverage (SQL/API-route behavior, Kutoff's own
// verification) lives in tests/pledge-balance-correction-e2e.test.mjs.

test("effectiveBalanceCents: no active correction -- the imported balance is the effective balance", () => {
  assert.equal(effectiveBalanceCents(21000, null), 21000);
  assert.equal(effectiveBalanceCents(0, null), 0);
});

test("effectiveBalanceCents: an active correction always wins, regardless of the imported value -- this is the single rule every SQL query site's own COALESCE realizes", () => {
  assert.equal(effectiveBalanceCents(21000, 0), 0, "requirement 1: correcting to $0");
  assert.equal(effectiveBalanceCents(21000, 5000), 5000, "requirement 2: correcting to another valid amount");
  assert.equal(effectiveBalanceCents(0, 1000), 1000, "a correction can also raise the balance, not only lower it -- the rule has no directional assumption");
});

test("activeCorrection: finds the one row with reversedAt === null among a pledge's full history", () => {
  const history = [
    { id: "c3", pledgeActivityId: "p1", importedBalanceCentsAtCorrection: 21000, correctedBalanceCents: 0, reason: "latest", createdAt: 300, reversedAt: null, reversalReason: null },
    { id: "c2", pledgeActivityId: "p1", importedBalanceCentsAtCorrection: 21000, correctedBalanceCents: 5000, reason: "superseded", createdAt: 200, reversedAt: 300, reversalReason: "Superseded by a new correction" },
    { id: "c1", pledgeActivityId: "p1", importedBalanceCentsAtCorrection: 21000, correctedBalanceCents: 10000, reason: "first", createdAt: 100, reversedAt: 200, reversalReason: "Superseded by a new correction" },
  ];
  assert.equal(activeCorrection(history)?.id, "c3");
});

test("activeCorrection: returns null when every row in the history is reversed -- the normal imported balance applies", () => {
  const history = [
    { id: "c1", pledgeActivityId: "p1", importedBalanceCentsAtCorrection: 21000, correctedBalanceCents: 0, reason: "r", createdAt: 100, reversedAt: 200, reversalReason: "Removed" },
  ];
  assert.equal(activeCorrection(history), null);
});

test("activeCorrection: an empty history (never corrected) returns null", () => {
  assert.equal(activeCorrection([]), null);
});

// ============================================================
// validateBalanceCorrection -- requirement 3 (reason required),
// requirement 5 (no invalid/negative amounts).
// ============================================================

test("requirement 5: negative amounts are rejected", () => {
  const result = validateBalanceCorrection(-100, "Some reason");
  assert.equal(result.ok, false);
});

test("requirement 5: fractional-cent (non-integer) amounts are rejected", () => {
  assert.equal(validateBalanceCorrection(100.5, "reason").ok, false);
});

test("requirement 5: non-numeric amounts are rejected", () => {
  assert.equal(validateBalanceCorrection("100", "reason").ok, false);
  assert.equal(validateBalanceCorrection(null, "reason").ok, false);
  assert.equal(validateBalanceCorrection(undefined, "reason").ok, false);
});

test("requirement 1: zero is a VALID corrected balance -- the real Kutoff case", () => {
  const result = validateBalanceCorrection(0, "JL error corrected in JL; the correction never reached the spreadsheet FOS imports from.");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.correctedBalanceCents, 0);
});

test("requirement 2: a positive corrected balance is valid", () => {
  const result = validateBalanceCorrection(5000, "Partial correction -- donor confirmed only part of the balance was waived.");
  assert.equal(result.ok, true);
});

test("requirement 3: a blank or whitespace-only reason is rejected -- a written explanation is mandatory", () => {
  assert.equal(validateBalanceCorrection(0, "").ok, false);
  assert.equal(validateBalanceCorrection(0, "   ").ok, false);
  assert.equal(validateBalanceCorrection(0, undefined).ok, false);
});

test("requirement 3: reason is trimmed before being accepted/stored", () => {
  const result = validateBalanceCorrection(0, "  Real reason with padding  ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.reason, "Real reason with padding");
});

test("an excessively long reason is rejected", () => {
  const result = validateBalanceCorrection(0, "x".repeat(MAX_BALANCE_CORRECTION_REASON_LENGTH + 1));
  assert.equal(result.ok, false);
});

// ============================================================
// Source-level checks: every consumer site named in docs/AI-HANDOFF.md's
// consumer map actually applies the effective-balance rule, and the two
// deliberately-excluded sites (data integrity checks, the real JL
// payment-application engine) deliberately do NOT.
// ============================================================

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every consumer query site realizes the SAME effective-balance rule via LEFT JOIN + COALESCE, aliased back to the unchanged `balance_cents` column name", async () => {
  const sites = [
    "lib/relationships/giving.ts",
    "lib/workspace/live-data.ts",
    "lib/portfolio-focus/data.ts",
    "lib/relationships/meeting-brief.ts",
    "app/pledge-review/page.tsx",
    "app/api/pledge-payment-plans/route.ts",
  ];
  for (const site of sites) {
    const source = await read(site);
    assert.match(source, /LEFT JOIN pledge_balance_corrections pbc ON pbc\.pledge_activity_id = g?a?\.?id AND pbc\.reversed_at IS NULL/, `${site} must join the corrections table`);
    assert.match(source, /COALESCE\(pbc\.corrected_balance_cents, g?a?\.?balance_cents\) AS balance_cents/, `${site} must alias the effective balance back to the unchanged \`balance_cents\` column name, so every downstream consumer needs zero changes`);
  }
});

test("requirement: data-integrity checks deliberately read the RAW imported balance, never the effective one -- correcting a pledge must never mask a real import defect", async () => {
  const source = await read("lib/data-health/queries.ts");
  assert.doesNotMatch(source, /pledge_balance_corrections/, "data-health integrity queries must never join the corrections table");
});

test("requirement: never create a fictitious payment -- the real JL payment-application engine reads the RAW balance, never the effective one, so a correction can never cause it to misallocate or fabricate an overpayment", async () => {
  const source = await read("lib/import/jl-payment-assignment.ts");
  assert.doesNotMatch(source, /pledge_balance_corrections/, "the payment-application engine must never read a corrected balance when deciding how to apply a real incoming JL payment");
});

test("requirement 17 (no donor-wide override): the correction schema/routes key everything by pledgeActivityId, never a donor-wide update", async () => {
  const createRoute = await read("app/api/pledge-balance-corrections/route.ts");
  assert.match(createRoute, /pledge_activity_id = \?/);
  assert.doesNotMatch(createRoute, /UPDATE giving_activities/i, "this feature must never write to giving_activities at all");
  assert.doesNotMatch(createRoute, /WHERE donor_id = \? AND user_id = \?[^`]*pledge_balance_corrections/, "corrections must never be written/queried donor-wide without a pledge_activity_id");
});
