import assert from "node:assert/strict";
import { donationExportRange, suggestedDonationRange, isoDate } from "../lib/import/jl-refresh.ts";
import { parseFinancialDate } from "../lib/financial-date.ts";

// Suggested Donation Export inverted-range bug (docs/AI-HANDOFF.md). Real
// Independent Staging state showed "Feb 23, 2027 - Sep 9, 2026" -- an
// impossible range where the suggested start was after the end. Root cause:
// jl_refresh_state.last_donation_range_end had been set to 2027-03-01 by
// donationExportRange(), which took the MAX activityDate across every
// giving_activity in an import batch -- including a real, legitimate
// partially_paid_pledge (id 660f2401-6a5d-4f8d-b0bf-bc3b4f66f4d5, DIN2022,
// committed $5,000.00, paid $2,500.02) whose "Due Date" of 2027-03-01 is a
// forward-looking installment due date, not proof any money was received by
// that date. suggestedDonationRange() then subtracted 6 days from that
// future value, producing the Feb 23, 2027 start shown in the UI.

const day = (iso) => parseFinancialDate(iso);

function activity(activityDate, category) {
  return { activityDate, category };
}

// ---- donationExportRange(): only completed_gift proves coverage ----

{
  const range = donationExportRange([
    activity(day("2026-08-01"), "completed_gift"),
    activity(day("2026-09-01"), "completed_gift"),
  ]);
  assert.deepEqual([isoDate(range.start), isoDate(range.end)], ["2026-08-01", "2026-09-01"], "completed gifts alone still compute the expected min/max");
}

{
  // The exact regression: a real, legitimate partially-paid pledge with a
  // future installment due date must never widen the detected range beyond
  // the actual completed-gift coverage.
  const range = donationExportRange([
    activity(day("2026-08-01"), "completed_gift"),
    activity(day("2027-03-01"), "partially_paid_pledge"),
  ]);
  assert.deepEqual([isoDate(range.start), isoDate(range.end)], ["2026-08-01", "2026-08-01"], "a future-dated partially-paid pledge must not extend the detected coverage range");
}

{
  const range = donationExportRange([
    activity(day("2026-08-01"), "completed_gift"),
    activity(day("2099-01-01"), "open_pledge"),
  ]);
  assert.deepEqual([isoDate(range.start), isoDate(range.end)], ["2026-08-01", "2026-08-01"], "an open pledge's due date must not extend the detected coverage range");
}

{
  const range = donationExportRange([activity(day("2027-03-01"), "partially_paid_pledge"), activity(day("2099-01-01"), "open_pledge")]);
  assert.deepEqual([range.start, range.end], [null, null], "with no completed gifts at all, the range is unknown, not fabricated from pledge due dates");
}

// ---- suggestedDonationRange(): the invariant + explicit fallback states ----

const TODAY = new Date("2026-09-09T00:00:00Z");

{
  // A: no prior JL donation imports.
  const suggestion = suggestedDonationRange(null, TODAY);
  assert.equal(suggestion.state, "no_prior_coverage");
  assert.equal(suggestion.start, null);
  assert.equal(isoDate(suggestion.end), "2026-09-09");
}

{
  // B: prior coverage ends before today -> next-uncovered-through-today range, with the existing 7-day overlap.
  const suggestion = suggestedDonationRange(day("2026-09-01"), TODAY);
  assert.equal(suggestion.state, "range");
  assert.equal(isoDate(suggestion.start), "2026-08-26");
  assert.equal(isoDate(suggestion.end), "2026-09-09");
  assert.ok(suggestion.start <= suggestion.end, "start must never exceed end");
}

{
  // Coverage ends yesterday.
  const suggestion = suggestedDonationRange(day("2026-09-08"), TODAY);
  assert.equal(suggestion.state, "range");
  assert.ok(suggestion.start <= suggestion.end);
}

{
  // C: prior coverage ends today -> already current, no range needed.
  const suggestion = suggestedDonationRange(day("2026-09-09"), TODAY);
  assert.equal(suggestion.state, "already_current");
  assert.equal(suggestion.start, null);
  assert.equal(suggestion.futureCoverageDetected, false);
  assert.equal(isoDate(suggestion.end), "2026-09-09");
}

{
  // D: the exact real regression -- coverage end is accidentally
  // future-dated (2027-03-01, exactly the staging value). Must never
  // produce an inverted range.
  const suggestion = suggestedDonationRange(day("2027-03-01"), TODAY);
  assert.equal(suggestion.state, "already_current");
  assert.equal(suggestion.start, null, "an inverted numeric start must never be returned");
  assert.equal(suggestion.futureCoverageDetected, true, "a future coverage end is flagged for diagnostics even though the UI-safe state is the same as 'already current'");
  assert.equal(isoDate(suggestion.end), "2026-09-09");
}

{
  // E: malformed/unknown prior coverage (negative or non-finite) -> neutral state, no fabricated date.
  for (const malformed of [-1, NaN, Infinity]) {
    const suggestion = suggestedDonationRange(malformed, TODAY);
    assert.equal(suggestion.state, "unknown_coverage", `malformed value ${malformed} must not produce a fabricated range`);
    assert.equal(suggestion.start, null);
  }
}

{
  // Timezone/DST: the calendar "today" must be identical regardless of the
  // wall-clock time portion of `now`, since suggestedDonationRange only
  // ever consults UTC calendar-date components.
  const late = suggestedDonationRange(day("2026-09-01"), new Date("2026-09-09T23:59:59Z"));
  const early = suggestedDonationRange(day("2026-09-01"), new Date("2026-09-09T00:00:01Z"));
  assert.equal(isoDate(late.end), isoDate(early.end), "the time-of-day component of `now` must never change the computed calendar day");
}

{
  // Invariant, swept across many lastRangeEnd values including ones well
  // past today: start must never exceed end.
  const probes = ["1991-02-06", "2026-08-01", "2026-09-08", "2026-09-09", "2026-09-10", "2027-03-01", "2099-01-01"];
  for (const iso of probes) {
    const suggestion = suggestedDonationRange(day(iso), TODAY);
    if (suggestion.state === "range") assert.ok(suggestion.start <= suggestion.end, `${iso}: start must never exceed end`);
    else assert.equal(suggestion.start, null, `${iso}: a non-range state must never carry a numeric start`);
  }
}

// ---- Real-data regression: the exact Independent Staging values ----

{
  // jl_refresh_state on Independent Staging (see docs/AI-HANDOFF.md):
  // last_donation_range_end = 1803859200 (2027-03-01T00:00:00Z), which
  // previously produced the impossible "Feb 23, 2027 - Sep 9, 2026" UI.
  const suggestion = suggestedDonationRange(1803859200, new Date("2026-09-09T00:00:00Z"));
  assert.notEqual(suggestion.state, "range", "the real staging value must never fall into the plain numeric-range state");
  assert.equal(suggestion.state, "already_current");
  assert.equal(suggestion.start, null);
}

console.log("Suggested donation range checks passed.");
