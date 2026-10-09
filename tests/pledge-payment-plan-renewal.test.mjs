import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluatePledgeRenewal } from "../lib/relationships/pledge-payment-plan.ts";
import { validateOriginalPledgeDate, validateCommitmentDurationMonths, MIN_COMMITMENT_DURATION_MONTHS, MAX_COMMITMENT_DURATION_MONTHS } from "../lib/capture/pledge-payment-plan.ts";
import { buildPledgeRenewalReminderEvents, partitionRelationshipDateEventsByToday } from "../lib/workspace/relationship-date-events.ts";

// Pledge Renewal Reminders (2026-10-08, see docs/AI-HANDOFF.md's
// "Annual Renewal Reminders -- Implemented" entry), corrected 2026-10-08
// to require a verified COMMITMENT DURATION rather than assuming every
// commitment lasts 12 months (see the "commitment duration" correction
// entry). Both originalPledgeDate and commitmentDurationMonths are
// fundraiser-VERIFIED only -- these tests never infer, backfill, or
// guess either value; every fixture either supplies both explicitly or
// explicitly tests a missing-field case.

const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
// A daytime Eastern instant (noon EDT / 11am EST, either way safely
// inside the Eastern calendar date `d` regardless of DST) -- matches
// tests/pledge-payment-plan-timezone.test.mjs's own convention.
const et = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);
const TZ = "America/New_York";

async function run() {
  // ============================================================
  // evaluatePledgeRenewal -- eligibility requires BOTH fields, the
  // worked examples for every duration, exact boundaries, leap years,
  // month-end clamping, DST.
  // ============================================================

  // --- Missing original date (duration present) -- not eligible. ---
  {
    const result = evaluatePledgeRenewal(null, 12, null, null, et(2026, 11, 1), TZ);
    assert.deepEqual(result, { renewalDate: null, fiveDayReminderDate: null, isFiveDayReminder: false, isRenewalDateReminder: false, isRenewalFollowUpNeeded: false });
  }

  // --- Missing duration (original date present) -- not eligible. This
  // is the entire point of the correction: a verified date ALONE must
  // never produce a reminder, since the old code's implicit "assume 12
  // months" default is exactly what was wrong. ---
  {
    const result = evaluatePledgeRenewal(utcMidnight(2025, 11, 1), null, null, null, et(2026, 11, 1), TZ);
    assert.deepEqual(result, { renewalDate: null, fiveDayReminderDate: null, isFiveDayReminder: false, isRenewalDateReminder: false, isRenewalFollowUpNeeded: false });
  }

  // --- Both fields missing -- not eligible. ---
  {
    const result = evaluatePledgeRenewal(null, null, null, null, et(2026, 11, 1), TZ);
    assert.equal(result.renewalDate, null);
  }

  // --- Explicitly ended plan -- never eligible, even with both fields
  // verified and even exactly on what would otherwise be the renewal
  // date. ---
  {
    const original = utcMidnight(2025, 11, 1);
    const result = evaluatePledgeRenewal(original, 12, utcMidnight(2026, 6, 1), null, et(2026, 11, 1), TZ);
    assert.equal(result.renewalDate, null, "an explicitly ended plan must never report a renewal date at all");
  }

  // --- The exact worked examples from the task, all four durations,
  // same original pledge date: Nov 1, 2025. ---
  {
    const original = utcMidnight(2025, 11, 1);
    assert.equal(evaluatePledgeRenewal(original, 6, null, null, et(2026, 5, 1), TZ).renewalDate, utcMidnight(2026, 5, 1), "6 months: Nov 1 2025 -> May 1 2026");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 11, 1), TZ).renewalDate, utcMidnight(2026, 11, 1), "12 months: Nov 1 2025 -> Nov 1 2026");
    assert.equal(evaluatePledgeRenewal(original, 18, null, null, et(2027, 5, 1), TZ).renewalDate, utcMidnight(2027, 5, 1), "18 months: Nov 1 2025 -> May 1 2027");
    assert.equal(evaluatePledgeRenewal(original, 24, null, null, et(2027, 11, 1), TZ).renewalDate, utcMidnight(2027, 11, 1), "24 months: Nov 1 2025 -> Nov 1 2027");
  }

  // --- A custom duration (not one of the UI presets) works identically
  // -- the evaluator takes any verified whole number of months, never
  // restricted to the preset list (the preset list is a UI convenience
  // only). ---
  {
    const original = utcMidnight(2025, 11, 1);
    const result = evaluatePledgeRenewal(original, 9, null, null, et(2026, 8, 1), TZ);
    assert.equal(result.renewalDate, utcMidnight(2026, 8, 1), "9 months: Nov 1 2025 -> Aug 1 2026 (a custom, non-preset duration)");
  }

  // --- Five-day reminder and renewal-day reminder, exact boundaries,
  // re-verified against the corrected (duration-driven) function, same
  // 12-month example as the original implementation's worked example. ---
  {
    const original = utcMidnight(2025, 11, 1);
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 27), TZ).isFiveDayReminder, true);
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 26), TZ).isFiveDayReminder, false, "the day immediately before the five-day reminder must not also fire it");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 28), TZ).isFiveDayReminder, false, "the day immediately after the five-day reminder must not also fire it");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 11, 1), TZ).isRenewalDateReminder, true);
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 31), TZ).isRenewalDateReminder, false, "the day immediately before the renewal date must not also fire it");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 11, 2), TZ).isRenewalDateReminder, false, "the day immediately after the renewal date must not also fire it");
    // No duplicate events -- five-day and renewal-day can never both be
    // true on the same day for the same plan (they are 5 real calendar
    // days apart by construction, for any duration).
    for (const [m, d] of [[10, 27], [11, 1]]) {
      const r = evaluatePledgeRenewal(original, 12, null, null, et(2026, m, d), TZ);
      assert.ok(!(r.isFiveDayReminder && r.isRenewalDateReminder), `${m}/${d} must never fire both stages at once`);
    }
  }

  // --- Leap year / February 29 original pledge date -- explicit,
  // documented convention preserved unchanged by the correction: clamps
  // to February 28 in the (non-leap) renewal year, the SAME clamp
  // advanceOneCalendarMonth already applies to a 31st-anchored monthly
  // cycle in a 30-day month, regardless of duration. ---
  {
    const feb29 = utcMidnight(2024, 2, 29); // 2024 is a leap year
    const result = evaluatePledgeRenewal(feb29, 12, null, null, et(2025, 2, 28), TZ);
    assert.equal(result.renewalDate, utcMidnight(2025, 2, 28), "a Feb 29 original pledge date must clamp its 12-month renewal to Feb 28 in the non-leap following year");
    assert.equal(result.isRenewalDateReminder, true);
    assert.equal(result.fiveDayReminderDate, utcMidnight(2025, 2, 23));
  }

  // --- Month-end clamping for a non-February, non-12-month case: a
  // pledge made on the 31st, with a 6-month duration landing in a
  // 30-day month (April), must clamp to the 30th -- not drift, not
  // overflow into May. ---
  {
    const oct31 = utcMidnight(2025, 10, 31);
    const result = evaluatePledgeRenewal(oct31, 6, null, null, et(2026, 4, 30), TZ);
    assert.equal(result.renewalDate, utcMidnight(2026, 4, 30), "Oct 31 2025 + 6 months must clamp to Apr 30 2026 (April has only 30 days), never drift into May");
  }

  // --- DST -- verified against the exact 2026 transition (EDT through
  // Oct 31, EST from Nov 1), same convention as
  // tests/pledge-payment-plan-timezone.test.mjs. ---
  {
    const original = utcMidnight(2025, 11, 1); // renewal Nov 1, 2026 -- EST by then
    const dayOfOnEst = evaluatePledgeRenewal(original, 12, null, null, et(2026, 11, 1), TZ);
    assert.equal(dayOfOnEst.isRenewalDateReminder, true, "a renewal date landing in the EST period must still fire correctly");
    const fiveDayStillEdt = evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 27), TZ); // still EDT
    assert.equal(fiveDayStillEdt.isFiveDayReminder, true, "the five-day reminder, 5 days earlier (still EDT), must also fire correctly");
    // Early morning / late evening Eastern -- stable across the whole
    // Eastern calendar day.
    const earlyMorning = Math.floor(Date.UTC(2026, 10, 1, 5, 30, 0) / 1000);
    const lateEvening = Math.floor(Date.UTC(2026, 10, 2, 3, 30, 0) / 1000);
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, earlyMorning, TZ).isRenewalDateReminder, true, "early morning Eastern on the renewal date must still fire");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, lateEvening, TZ).isRenewalDateReminder, true, "late evening Eastern on the renewal date must still fire");
  }

  // ============================================================
  // Renewal Follow-Up (2026-10-09, see docs/AI-HANDOFF.md's Spetner
  // (2689) investigation) -- isRenewalFollowUpNeeded persists every day
  // after the renewal date, with no upper bound, unlike
  // isFiveDayReminder/isRenewalDateReminder which only ever fire on
  // their own exact single day.
  // ============================================================
  {
    const original = utcMidnight(2025, 9, 26); // Spetner's real original pledge date
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 9, 25), TZ).isRenewalFollowUpNeeded, false, "the day before the renewal date must not need follow-up");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 9, 26), TZ).isRenewalFollowUpNeeded, false, "the renewal date itself is its own one-day reminder, never also the follow-up state");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 9, 27), TZ).isRenewalFollowUpNeeded, true, "the day immediately after the renewal date must need follow-up");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 9), TZ).isRenewalFollowUpNeeded, true, "13 days after (Spetner's real case) must still need follow-up -- this never expires on its own");
    assert.equal(evaluatePledgeRenewal(original, 12, null, null, et(2028, 1, 1), TZ).isRenewalFollowUpNeeded, true, "even over a year later, with no resolution mechanism in this app yet, it must still need follow-up -- the safe default is to keep surfacing, never to silently expire");
    // Never true at all once the plan is formally ended, no matter how
    // far past the renewal date -- matches evaluatePledgeRenewal's own
    // existing endedAt short-circuit.
    assert.equal(evaluatePledgeRenewal(original, 12, utcMidnight(2026, 10, 1), null, et(2026, 11, 1), TZ).isRenewalFollowUpNeeded, false, "an ended plan must never need follow-up");
    // Mutually exclusive with isRenewalDateReminder for every day across
    // a wide range -- never both true at once for the same plan.
    for (let offset = -10; offset <= 20; offset++) {
      const r = evaluatePledgeRenewal(original, 12, null, null, et(2026, 9, 26) + offset * 86400, TZ);
      assert.ok(!(r.isRenewalDateReminder && r.isRenewalFollowUpNeeded), `offset ${offset}: must never report both the exact-day reminder and the follow-up state at once`);
    }
  }

  // ============================================================
  // Mark Renewal Addressed (2026-10-09, see docs/AI-HANDOFF.md) --
  // renewalAcknowledgedAt suppresses ONLY isRenewalFollowUpNeeded, never
  // isFiveDayReminder/isRenewalDateReminder (requirement: preserve the
  // existing five-day/renewal-date reminder behavior), never
  // originalPledgeDate/commitmentDurationMonths/renewalDate itself
  // (requirement: preserve the original pledge date and commitment
  // duration -- re-verified here as "the renewal date is still
  // computed and reported, unchanged").
  // ============================================================
  {
    const original = utcMidnight(2025, 9, 26); // Spetner's real original pledge date
    const acknowledgedAt = et(2026, 10, 9); // the moment the fundraiser clicked the button

    // --- Unacknowledged renewal: follow-up is needed, exactly as
    // before (the existing coverage above re-verified with an explicit
    // null). ---
    const unacknowledged = evaluatePledgeRenewal(original, 12, null, null, et(2026, 10, 9), TZ);
    assert.equal(unacknowledged.isRenewalFollowUpNeeded, true);

    // --- Successfully acknowledged renewal: follow-up stops, even on
    // the exact same day it would otherwise have been true, and even
    // far beyond it -- acknowledgment never "wears off." ---
    for (const now of [et(2026, 10, 9), et(2026, 11, 1), et(2028, 1, 1)]) {
      const acknowledged = evaluatePledgeRenewal(original, 12, null, acknowledgedAt, now, TZ);
      assert.equal(acknowledged.isRenewalFollowUpNeeded, false, `follow-up must stay suppressed once acknowledged, checked at ${now}`);
    }

    // --- The renewal date/five-day date are STILL computed and
    // reported, unchanged by acknowledgment -- only the standing
    // follow-up signal is suppressed. ---
    const acknowledged = evaluatePledgeRenewal(original, 12, null, acknowledgedAt, et(2026, 10, 9), TZ);
    assert.equal(acknowledged.renewalDate, unacknowledged.renewalDate, "the original pledge date + commitment duration (and therefore the renewal date) must be unaffected by acknowledgment");
    assert.equal(acknowledged.fiveDayReminderDate, unacknowledged.fiveDayReminderDate);

    // --- Acknowledgment never retroactively suppresses the existing
    // five-day/renewal-date one-day reminders -- they still fire on
    // their own exact days exactly as an unacknowledged plan would,
    // since acknowledgment is only ever realistic AFTER the renewal
    // date has already passed (nothing in this function prevents
    // testing the hypothetical anyway, to prove the independence is
    // structural, not merely coincidental). ---
    assert.equal(evaluatePledgeRenewal(original, 12, null, acknowledgedAt, et(2026, 9, 26), TZ).isRenewalDateReminder, true, "the exact-day renewal reminder must still fire even on a plan that happens to already carry an (earlier) acknowledgment");
    assert.equal(evaluatePledgeRenewal(original, 12, null, acknowledgedAt, et(2026, 9, 21), TZ).isFiveDayReminder, true, "the five-day reminder must still fire unchanged too");

    // --- ended_at is never used to acknowledge a renewal, and
    // acknowledging never substitutes for ending -- the two remain
    // fully independent axes (requirement 5 + 6's own spirit: not
    // "do not auto-create," but structurally, acknowledgment carries no
    // plan-lifecycle meaning at all). An ended, unacknowledged plan is
    // already correctly suppressed via endedAt alone (see the test
    // above); an ended, ALSO-acknowledged plan reports the exact same
    // ineligible shape -- acknowledgment adds nothing once already
    // ended. ---
    const endedAndAcknowledged = evaluatePledgeRenewal(original, 12, utcMidnight(2026, 10, 1), acknowledgedAt, et(2026, 11, 1), TZ);
    assert.deepEqual(endedAndAcknowledged, { renewalDate: null, fiveDayReminderDate: null, isFiveDayReminder: false, isRenewalDateReminder: false, isRenewalFollowUpNeeded: false });
  }

  // ============================================================
  // validateOriginalPledgeDate / validateCommitmentDurationMonths --
  // creation/editing/clearing/invalid/future/fractional/out-of-range.
  // ============================================================
  {
    const now = et(2026, 10, 8);

    // --- Original pledge date: unchanged behavior, re-verified. ---
    assert.deepEqual(validateOriginalPledgeDate(undefined, now, TZ), { ok: true, originalPledgeDate: null });
    assert.deepEqual(validateOriginalPledgeDate("2025-11-01", now, TZ), { ok: true, originalPledgeDate: utcMidnight(2025, 11, 1) });
    assert.equal(validateOriginalPledgeDate("2025-02-30", now, TZ).ok, false, "February 30 does not exist");
    assert.equal(validateOriginalPledgeDate("2026-10-09", now, TZ).ok, false, "tomorrow must be rejected as a future date");

    // --- Commitment duration: absent/null is always valid (not yet
    // verified), never defaults to 12 or any other value. ---
    assert.deepEqual(validateCommitmentDurationMonths(undefined), { ok: true, commitmentDurationMonths: null });
    assert.deepEqual(validateCommitmentDurationMonths(null), { ok: true, commitmentDurationMonths: null });

    // --- Each preset and a custom whole-month value are all valid. ---
    for (const months of [6, 12, 18, 24, 9, 1, MAX_COMMITMENT_DURATION_MONTHS]) {
      assert.deepEqual(validateCommitmentDurationMonths(months), { ok: true, commitmentDurationMonths: months }, `${months} months must be accepted`);
    }

    // --- Fractional durations are rejected -- "18.5 months" is not a
    // real commitment length. ---
    assert.equal(validateCommitmentDurationMonths(18.5).ok, false, "a fractional duration must be rejected");
    assert.equal(validateCommitmentDurationMonths(6.0).ok, true, "6.0 is still a whole number (Number.isInteger(6.0) === true) and must be accepted");

    // --- Out-of-range durations are rejected: zero, negative, and
    // beyond the documented maximum. ---
    assert.equal(validateCommitmentDurationMonths(0).ok, false, "zero months is not a real commitment length");
    assert.equal(validateCommitmentDurationMonths(-6).ok, false, "a negative duration must be rejected");
    assert.equal(validateCommitmentDurationMonths(MAX_COMMITMENT_DURATION_MONTHS + 1).ok, false, "a duration beyond the documented maximum must be rejected");
    assert.equal(MIN_COMMITMENT_DURATION_MONTHS, 1);

    // --- Non-numeric input is rejected (never silently coerced). ---
    assert.equal(validateCommitmentDurationMonths("12").ok, false, "a string must be rejected -- the UI always sends a number");
  }

  // ============================================================
  // buildPledgeRenewalReminderEvents -- shape, multiple plans per donor,
  // no duplicate event ids, identity-gated, 14-day upcoming window,
  // Today/Coming Up bucketing, outstanding balances, fully paid plans.
  // ============================================================
  {
    const identityByDonor = new Map([
      ["donor-1", { donorName: "Mr. & Mrs. Test Donor", initials: "TD", donorCode: "12345" }],
    ]);
    const now = et(2026, 11, 1);
    const todayEpoch = utcMidnight(2026, 11, 1);

    // --- Multiple plans for one donor, pledge-specific: plan A's
    // renewal fires today (12-month commitment); plan B is a DIFFERENT
    // duration (6-month commitment) with both stages upcoming inside the
    // 14-day window. Neither plan's eligibility or dates can be
    // influenced by the other -- evaluatePledgeRenewal/
    // buildPledgeRenewalReminderEvents take no "other plans for this
    // donor" input at all. ---
    const rows = [
      { donorId: "donor-1", planId: "plan-a", pledgeActivityId: "pledge-a", originalPledgeDate: utcMidnight(2025, 11, 1), commitmentDurationMonths: 12, originalPledgeAmountCents: 120000, balanceCents: 10000, campaign: "GENOP2025", renewalDate: utcMidnight(2026, 11, 1), fiveDayReminderDate: utcMidnight(2026, 10, 27) },
      { donorId: "donor-1", planId: "plan-b", pledgeActivityId: "pledge-b", originalPledgeDate: utcMidnight(2026, 5, 10), commitmentDurationMonths: 6, originalPledgeAmountCents: 500000, balanceCents: 400000, campaign: "CAPITAL2026", renewalDate: utcMidnight(2026, 11, 10), fiveDayReminderDate: utcMidnight(2026, 11, 5) },
    ];
    const events = buildPledgeRenewalReminderEvents(rows, identityByDonor, TZ, now);
    assert.equal(events.length, 3, "plan A contributes 1 (its five-day mark already passed) and plan B contributes 2 (both stages inside the window) = 3");
    const ids = events.map((e) => e.id);
    assert.equal(new Set(ids).size, 3, "event ids must never collide between two different plans, or between a plan's own two stages");
    assert.ok(events.every((e) => e.type === "pledge_renewal"));

    const onDay = events.find((e) => e.id === "pledge-renewal:plan-a:renewal");
    const planBApproaching = events.find((e) => e.id === "pledge-renewal:plan-b:approaching");
    const planBRenewal = events.find((e) => e.id === "pledge-renewal:plan-b:renewal");
    assert.ok(onDay && planBApproaching && planBRenewal);

    // --- Exact required titles, verbatim -- "Annual" dropped, since
    // plan B is a 6-month commitment, never annual. ---
    assert.equal(onDay.relationshipPhrase, "Pledge renewal opportunity");
    assert.equal(planBApproaching.relationshipPhrase, "Pledge renewal approaching");
    assert.equal(planBRenewal.relationshipPhrase, "Pledge renewal opportunity");

    // --- The correct FUTURE event date is shown, never today's date --
    // dateEpoch (bucketing/sort) is the stage's own real date; dateLabel
    // (what's rendered) is always the renewal date itself. ---
    assert.equal(onDay.dateEpoch, todayEpoch, "plan A's renewal fires today");
    assert.equal(onDay.dateLabel, "Nov 1, 2026");
    assert.equal(planBApproaching.dateEpoch, utcMidnight(2026, 11, 5), "plan B's approaching stage carries ITS OWN real date, not today's");
    assert.notEqual(planBApproaching.dateEpoch, todayEpoch);
    assert.equal(planBApproaching.dateLabel, "Nov 10, 2026", "dateLabel always shows the renewal date itself, even for the approaching stage");
    assert.equal(planBRenewal.dateEpoch, utcMidnight(2026, 11, 10));
    assert.equal(planBRenewal.dateLabel, "Nov 10, 2026");

    // --- No duplicate events between Today and Coming Up -- every
    // event lands in exactly one of the two partitioned buckets. ---
    const { today: todayBucket, upcoming: upcomingBucket } = partitionRelationshipDateEventsByToday(events, now, TZ);
    assert.deepEqual(todayBucket.map((e) => e.id).sort(), ["pledge-renewal:plan-a:renewal"]);
    assert.deepEqual(upcomingBucket.map((e) => e.id).sort(), ["pledge-renewal:plan-b:approaching", "pledge-renewal:plan-b:renewal"]);
    assert.equal(todayBucket.length + upcomingBucket.length, events.length, "every event lands in exactly one bucket -- none dropped, none duplicated");

    // --- 14-day Coming Up window boundary: exactly 14 days out still
    // qualifies, 15 days out does not. ---
    const boundaryRow = { donorId: "donor-1", planId: "plan-c", pledgeActivityId: "pledge-c", originalPledgeDate: utcMidnight(2025, 11, 15), commitmentDurationMonths: 12, originalPledgeAmountCents: 100000, balanceCents: 0, campaign: null, renewalDate: utcMidnight(2026, 11, 15), fiveDayReminderDate: utcMidnight(2026, 11, 10) };
    const exactly14Out = buildPledgeRenewalReminderEvents([boundaryRow], identityByDonor, TZ, now);
    assert.equal(exactly14Out.filter((e) => e.id.endsWith(":renewal")).length, 1, "exactly 14 days out must still appear in the upcoming window");
    const beyond14 = { ...boundaryRow, planId: "plan-d", renewalDate: utcMidnight(2026, 11, 16), fiveDayReminderDate: utcMidnight(2026, 11, 11) };
    const exactly15Out = buildPledgeRenewalReminderEvents([beyond14], identityByDonor, TZ, now);
    assert.equal(exactly15Out.filter((e) => e.id.endsWith(":renewal")).length, 0, "15 days out must NOT appear yet -- beyond the 14-day lead window");

    // --- A date that has already passed must never retroactively
    // reappear via the bounded approaching/renewal stages specifically
    // (isRenewalFollowUpNeeded absent/false on this fixture). ---
    const alreadyPassed = { ...rows[0], planId: "plan-e", renewalDate: utcMidnight(2026, 10, 20), fiveDayReminderDate: utcMidnight(2026, 10, 15) };
    const pastEvents = buildPledgeRenewalReminderEvents([alreadyPassed], identityByDonor, TZ, now);
    assert.equal(pastEvents.length, 0, "a stage date before today must never fire retroactively via the approaching/renewal stages");

    // --- Renewal Follow-Up (2026-10-09, see docs/AI-HANDOFF.md): once
    // isRenewalFollowUpNeeded is true, a standing event appears in Today
    // every day, however far in the past the renewal date is -- well
    // beyond the 14-day lead window that bounds the other two stages. ---
    const followUpRow = { ...rows[0], planId: "plan-f", renewalDate: utcMidnight(2026, 8, 1), fiveDayReminderDate: utcMidnight(2026, 7, 27), isRenewalFollowUpNeeded: true };
    const followUpEvents = buildPledgeRenewalReminderEvents([followUpRow], identityByDonor, TZ, now);
    assert.equal(followUpEvents.length, 1, "exactly one follow-up event, no approaching/renewal stages (both long past)");
    const followUp = followUpEvents[0];
    assert.equal(followUp.id, "pledge-renewal:plan-f:follow_up");
    assert.equal(followUp.relationshipPhrase, "Renewal follow-up needed");
    assert.equal(followUp.dateEpoch, todayEpoch, "the follow-up event is pinned to TODAY, not the long-past renewal date, so it always lands in the Today bucket");
    assert.equal(followUp.dateLabel, "Aug 1, 2026", "dateLabel still shows the plan's own real (lapsed) renewal date for context, even while dateEpoch is pinned to today");
    const { today: followUpToday, upcoming: followUpUpcoming } = partitionRelationshipDateEventsByToday(followUpEvents, now, TZ);
    assert.deepEqual(followUpToday.map((e) => e.id), ["pledge-renewal:plan-f:follow_up"], "a lapsed renewal follow-up belongs in Today, never Coming Up");
    assert.equal(followUpUpcoming.length, 0);

    // --- isRenewalFollowUpNeeded: false (or absent) never produces the
    // follow-up event, even when the renewal date is in the past -- only
    // the explicit flag controls it, matching plan-e's fixture above. ---
    const notNeededRow = { ...followUpRow, planId: "plan-g", isRenewalFollowUpNeeded: false };
    assert.equal(buildPledgeRenewalReminderEvents([notNeededRow], identityByDonor, TZ, now).length, 0);

    // --- Calling the builder again on a later "day" never produces a
    // second, duplicate follow-up event for the same plan -- it is
    // always re-derived fresh, never accumulated/stored. ---
    const laterNow = et(2026, 11, 5);
    const laterToday = utcMidnight(2026, 11, 5);
    const laterEvents = buildPledgeRenewalReminderEvents([followUpRow], identityByDonor, TZ, laterNow);
    assert.equal(laterEvents.length, 1, "still exactly one follow-up event on a later day, never accumulating");
    assert.equal(laterEvents[0].dateEpoch, laterToday, "its dateEpoch tracks whichever day it's computed on, so it keeps landing in Today rather than stacking");

    // --- Outstanding balance vs. fully paid -- neither suppresses the
    // event; balance and the verified duration are both shown as
    // context either way. ---
    assert.match(onDay.secondaryDateLabel, /\$1,200\.00 pledged \(GENOP2025\)/);
    assert.match(onDay.secondaryDateLabel, /12-month commitment/);
    assert.match(onDay.secondaryDateLabel, /\$100\.00 balance remaining/);
    const fullyPaidRows = [{ ...rows[0], balanceCents: 0 }];
    const fullyPaidEvents = buildPledgeRenewalReminderEvents(fullyPaidRows, identityByDonor, TZ, now);
    assert.equal(fullyPaidEvents.length, 1, "a fully paid commitment must still generate its own renewal reminder -- not automatically treated as irrelevant");
    assert.match(fullyPaidEvents[0].secondaryDateLabel, /\$0\.00 balance remaining/);

    // --- A donor with no identity row is silently skipped. ---
    const noIdentity = buildPledgeRenewalReminderEvents(rows, new Map(), TZ, now);
    assert.equal(noIdentity.length, 0);

    // --- Campaign absent (null) must still render a complete, valid
    // line -- never a literal "(null)" or broken parens. ---
    const noCampaignRows = [{ ...rows[0], campaign: null }];
    const noCampaignEvents = buildPledgeRenewalReminderEvents(noCampaignRows, identityByDonor, TZ, now);
    assert.doesNotMatch(noCampaignEvents[0].secondaryDateLabel, /null/);
    assert.match(noCampaignEvents[0].secondaryDateLabel, /^\$1,200\.00 pledged · 12-month commitment/);
  }

  // ============================================================
  // Coexistence with the existing 15/10/5-day final-payment milestone --
  // unchanged by this correction; the two remain independent
  // computations over independent inputs.
  // ============================================================
  {
    const plan = { nextExpectedPaymentAt: utcMidnight(2026, 9, 24), expectedDayOfMonth: 24, finalExpectedPaymentAt: utcMidnight(2026, 10, 24), endedAt: null };
    const { evaluatePaymentPlan } = await import("../lib/relationships/pledge-payment-plan.ts");
    const milestoneResult = evaluatePaymentPlan(plan, [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)], 2000, et(2026, 10, 9), TZ);
    assert.equal(milestoneResult.milestoneDaysBefore, 15, "the existing final-payment milestone must still fire normally");
    const renewalResult = evaluatePledgeRenewal(utcMidnight(2025, 10, 9), 12, plan.endedAt, null, et(2026, 10, 9), TZ);
    assert.equal(renewalResult.isRenewalDateReminder, true, "the pledge renewal can independently fire for the same plan on the same day");
    const milestoneResultAgain = evaluatePaymentPlan(plan, [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)], 2000, et(2026, 10, 9), TZ);
    assert.deepEqual(milestoneResultAgain, milestoneResult, "evaluating pledge renewal must never change the final-payment milestone's own result for the same plan");
  }

  // --- IMPORTANT: commitment duration is NOT the payment-plan's own
  // collection schedule -- a 12-month commitment paid over 18 months of
  // installments must still renew at 12 months, never 18. Verified
  // directly: the payment-plan's own finalExpectedPaymentAt (18 months
  // out) is completely ignored by evaluatePledgeRenewal, which only ever
  // reads originalPledgeDate + commitmentDurationMonths. ---
  {
    const original = utcMidnight(2025, 11, 1);
    const commitmentDurationMonths = 12; // the donor committed to 12 months...
    const finalExpectedPaymentAt = utcMidnight(2027, 5, 1); // ...but is paying it off over 18 months of installments
    const result = evaluatePledgeRenewal(original, commitmentDurationMonths, null, null, et(2026, 11, 1), TZ);
    assert.equal(result.renewalDate, utcMidnight(2026, 11, 1), "the renewal date must follow the 12-month COMMITMENT, completely ignoring the 18-month collection schedule");
    assert.notEqual(result.renewalDate, finalExpectedPaymentAt, "the renewal date must never coincide with or be derived from the payment plan's own final expected payment date");
  }

  // ============================================================
  // Route wiring -- create and edit routes, structural checks.
  // ============================================================
  {
    const createRoute = fs.readFileSync(new URL("../app/api/pledge-payment-plans/route.ts", import.meta.url), "utf8");
    assert.match(createRoute, /validateOriginalPledgeDate\(body\.originalPledgeDate, createdAtForAnchor, profile\.timezone\)/, "the create route must validate originalPledgeDate the same way as every other date field");
    assert.match(createRoute, /validateCommitmentDurationMonths\(body\.commitmentDurationMonths\)/, "the create route must validate commitmentDurationMonths");
    assert.match(createRoute, /commitment_duration_months/, "the create route's INSERT must include commitment_duration_months");
    assert.match(createRoute, /"commitmentDurationMonths"/, "the create route's audit changedFields must record commitmentDurationMonths");

    const editRoute = fs.readFileSync(new URL("../app/api/pledge-payment-plans/[id]/route.ts", import.meta.url), "utf8");
    assert.match(editRoute, /Object\.hasOwn\(body, "originalPledgeDate"\)/, "the edit route must gate on presence for originalPledgeDate");
    assert.match(editRoute, /Object\.hasOwn\(body, "commitmentDurationMonths"\)/, "the edit route must gate on presence for commitmentDurationMonths, distinguishing 'leave unchanged' from 'explicit clear'");
    assert.match(editRoute, /validateCommitmentDurationMonths\(body\.commitmentDurationMonths\)/);
    assert.match(editRoute, /commitment_duration_months = \?/, "the edit route's UPDATE must include commitment_duration_months");
  }

  console.log("pledge-payment-plan-renewal: ok");
}

await run();
