import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluateAnnualRenewal } from "../lib/relationships/pledge-payment-plan.ts";
import { validateOriginalPledgeDate } from "../lib/capture/pledge-payment-plan.ts";
import { buildAnnualRenewalReminderEvents, partitionRelationshipDateEventsByToday } from "../lib/workspace/relationship-date-events.ts";

// Annual Renewal Reminders, Parts 1-8 (2026-10-08, see docs/AI-HANDOFF.md's
// "Annual Renewal Reminders -- Implemented" entry). originalPledgeDate is
// fundraiser-VERIFIED only -- these tests never infer, backfill, or guess
// a date; every fixture either supplies an explicit originalPledgeDate or
// explicitly tests the null/not-yet-verified case.

const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
// A daytime Eastern instant (noon EDT / 11am EST, either way safely
// inside the Eastern calendar date `d` regardless of DST) -- the one
// correct way to pin down "now, on this exact Eastern calendar date,"
// matching the convention established by the 2026-10-08 timezone fix's
// own test suite (tests/pledge-payment-plan-timezone.test.mjs).
const et = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);
const TZ = "America/New_York";

async function run() {
  // ============================================================
  // evaluateAnnualRenewal -- eligibility, the worked example, exact
  // boundaries, leap years, DST, ended plans.
  // ============================================================

  // --- 7: a plan with originalPledgeDate = NULL (not yet verified) must
  // never generate a reminder, regardless of `now`. ---
  {
    const result = evaluateAnnualRenewal(null, null, et(2026, 11, 1), TZ);
    assert.deepEqual(result, { anniversaryDate: null, fiveDayReminderDate: null, isFiveDayReminder: false, isAnniversaryReminder: false });
  }

  // --- 16: an explicitly ended plan must never generate a new reminder,
  // even with a verified originalPledgeDate and even exactly on what
  // would otherwise be the anniversary date. ---
  {
    const original = utcMidnight(2025, 11, 1);
    const result = evaluateAnnualRenewal(original, utcMidnight(2026, 6, 1), et(2026, 11, 1), TZ);
    assert.equal(result.anniversaryDate, null, "an explicitly ended plan must never report an anniversary date at all");
    assert.equal(result.isAnniversaryReminder, false);
  }

  // --- The exact worked example from the task: pledged Nov 1 2025 ->
  // anniversary Nov 1 2026, five-day reminder Oct 27 2026. ---
  {
    const original = utcMidnight(2025, 11, 1);
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 11, 1), TZ).anniversaryDate, utcMidnight(2026, 11, 1));
    // --- 8: exactly five days before. ---
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 10, 27), TZ).isFiveDayReminder, true);
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 10, 26), TZ).isFiveDayReminder, false, "the day immediately before the five-day reminder must not also fire it");
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 10, 28), TZ).isFiveDayReminder, false, "the day immediately after the five-day reminder must not also fire it");
    // --- 9: exact anniversary. ---
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 11, 1), TZ).isAnniversaryReminder, true);
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 10, 31), TZ).isAnniversaryReminder, false, "the day immediately before the anniversary must not also fire it");
    assert.equal(evaluateAnnualRenewal(original, null, et(2026, 11, 2), TZ).isAnniversaryReminder, false, "the day immediately after the anniversary must not also fire it");
    // --- 17: no duplicate reminders -- five-day and anniversary can never
    // both be true on the same day for the same plan (they are 5 real
    // calendar days apart by construction). ---
    for (const [m, d] of [[10, 27], [11, 1]]) {
      const r = evaluateAnnualRenewal(original, null, et(2026, m, d), TZ);
      assert.ok(!(r.isFiveDayReminder && r.isAnniversaryReminder), `${m}/${d} must never fire both stages at once`);
    }
  }

  // --- 19: leap year / February 29 original pledge date -- explicit,
  // documented convention: clamps to February 28 in the (non-leap)
  // anniversary year, the SAME clamp advanceOneCalendarMonth already
  // applies to a 31st-anchored monthly cycle in a 30-day month (not a
  // new rule). ---
  {
    const feb29 = utcMidnight(2024, 2, 29); // 2024 is a leap year
    const result = evaluateAnnualRenewal(feb29, null, et(2025, 2, 28), TZ);
    assert.equal(result.anniversaryDate, utcMidnight(2025, 2, 28), "a Feb 29 original pledge date must clamp its first anniversary to Feb 28 in the non-leap following year");
    assert.equal(result.isAnniversaryReminder, true);
    assert.equal(result.fiveDayReminderDate, utcMidnight(2025, 2, 23));
  }

  // --- 19: a genuinely leap-landing anniversary -- original pledge date
  // Feb 29, 2024 is itself inside a leap year, but ITS first anniversary
  // (2025) is not a leap year, so this is the only case this feature can
  // exercise -- a second-year anniversary (2028, itself a leap year, land
  // on Feb 29 again) is explicitly out of scope (Part 3.5: no automatic
  // 2nd-year reminder). ---
  {
    const feb29 = utcMidnight(2024, 2, 29);
    const anchorDayPreserved = evaluateAnnualRenewal(feb29, null, et(2025, 1, 1), TZ);
    assert.equal(new Date(anchorDayPreserved.anniversaryDate * 1000).getUTCDate(), 28, "the clamp only affects the 2025 landing, confirmed via the actual computed date");
  }

  // --- 19: Eastern DST -- verified against the exact 2026 transition
  // dates (EDT through Oct 31, EST from Nov 1 -- same convention as
  // tests/pledge-payment-plan-timezone.test.mjs, confirmed there directly
  // against Intl/IANA data). An anniversary landing exactly on the
  // fall-back day itself must still fire correctly. ---
  {
    const original = utcMidnight(2025, 11, 1); // anniversary Nov 1, 2026 -- EST by then
    const dayOfOnEst = evaluateAnnualRenewal(original, null, et(2026, 11, 1), TZ);
    assert.equal(dayOfOnEst.isAnniversaryReminder, true, "an anniversary landing in the EST period must still fire correctly");
    const fiveDayStillEdt = evaluateAnnualRenewal(original, null, et(2026, 10, 27), TZ); // still EDT
    assert.equal(fiveDayStillEdt.isFiveDayReminder, true, "the five-day reminder, 5 days earlier (still EDT), must also fire correctly -- the transition between the two stages must not break either");
  }

  // --- Early morning / late evening Eastern -- stable across the whole
  // Eastern calendar day (the entire point of normalizing `now` once, at
  // the top, via the same today() helper the 2026-10-08 timezone fix
  // established). ---
  {
    const original = utcMidnight(2025, 11, 1);
    const earlyMorning = Math.floor(Date.UTC(2026, 10, 1, 5, 30, 0) / 1000); // 00:30 EDT... actually 01:30 EDT
    const lateEvening = Math.floor(Date.UTC(2026, 10, 2, 3, 30, 0) / 1000); // 23:30 EDT Nov 1
    assert.equal(evaluateAnnualRenewal(original, null, earlyMorning, TZ).isAnniversaryReminder, true, "early morning Eastern on the anniversary date must still fire");
    assert.equal(evaluateAnnualRenewal(original, null, lateEvening, TZ).isAnniversaryReminder, true, "late evening Eastern on the anniversary date must still fire");
  }

  // ============================================================
  // validateOriginalPledgeDate -- creation/editing/clearing/invalid/future.
  // ============================================================
  {
    const now = et(2026, 10, 8);

    // --- 1/7: absent/null (not yet verified) is always valid, resolves
    // to null, never defaults to "today" or any other guessed value. ---
    assert.deepEqual(validateOriginalPledgeDate(undefined, now, TZ), { ok: true, originalPledgeDate: null });
    assert.deepEqual(validateOriginalPledgeDate(null, now, TZ), { ok: true, originalPledgeDate: null });

    // --- 3: editing to a valid past date. ---
    assert.deepEqual(validateOriginalPledgeDate("2025-11-01", now, TZ), { ok: true, originalPledgeDate: utcMidnight(2025, 11, 1) });

    // --- 5: invalid calendar dates are rejected (parseFinancialDate's
    // own structural validUtcDate check -- never a new validation rule). ---
    assert.equal(validateOriginalPledgeDate("2025-02-30", now, TZ).ok, false, "February 30 does not exist");
    assert.equal(validateOriginalPledgeDate("not-a-date", now, TZ).ok, false);

    // --- 6: future dates are rejected, relative to the fundraiser's OWN
    // Eastern calendar date (not a raw UTC comparison -- same convention
    // as the 2026-10-08 timezone fix). ---
    assert.equal(validateOriginalPledgeDate("2026-10-09", now, TZ).ok, false, "tomorrow must be rejected as a future date");
    // Exactly today (Eastern) must be accepted -- the boundary itself is
    // valid, only strictly-future dates are rejected.
    assert.deepEqual(validateOriginalPledgeDate("2026-10-08", now, TZ), { ok: true, originalPledgeDate: utcMidnight(2026, 10, 8) });
  }

  // ============================================================
  // buildAnnualRenewalReminderEvents -- shape, multiple plans per donor,
  // no duplicate event ids, identity-gated, and (2026-10-08 Coming Up
  // fix) the upcoming-date window: a stage's event now appears every day
  // from RELATIONSHIP_DATE_LEAD_WINDOW_DAYS (14) out through its own
  // exact date, with dateEpoch equal to that stage's REAL date (not
  // always "today" as before the fix) -- so partitionRelationshipDateEventsByToday
  // correctly routes it to "today" only on the exact day and to
  // "upcoming" (Coming Up) on every earlier day inside the window.
  // ============================================================
  {
    const identityByDonor = new Map([
      ["donor-1", { donorName: "Mr. & Mrs. Test Donor", initials: "TD", donorCode: "12345" }],
    ]);
    const now = et(2026, 11, 1);
    const todayEpoch = utcMidnight(2026, 11, 1);

    // --- 10/4 (part 4 pledge-specific): a donor with TWO active plans on
    // different programs -- both independently eligible, both get their
    // own event(s), neither suppresses the other. This is the entire
    // resolution of Part 4's "newer pledge to a different program must
    // not suppress" requirement: evaluateAnnualRenewal/
    // buildAnnualRenewalReminderEvents take no "other plans for this
    // donor" input at all, so one plan structurally cannot influence
    // another's eligibility. Plan A's anniversary is exactly today (only
    // its "anniversary" stage qualifies -- its five-day mark, Oct 27, is
    // already in the past). Plan B's anniversary is 9 days out and its
    // five-day mark is 4 days out -- BOTH comfortably inside the 14-day
    // window, so plan B alone demonstrates both stages appearing as
    // upcoming (Coming Up) at once. ---
    const rows = [
      { donorId: "donor-1", planId: "plan-a", pledgeActivityId: "pledge-a", originalPledgeDate: utcMidnight(2025, 11, 1), originalPledgeAmountCents: 120000, balanceCents: 10000, campaign: "GENOP2025", anniversaryDate: utcMidnight(2026, 11, 1), fiveDayReminderDate: utcMidnight(2026, 10, 27) },
      { donorId: "donor-1", planId: "plan-b", pledgeActivityId: "pledge-b", originalPledgeDate: utcMidnight(2025, 11, 10), originalPledgeAmountCents: 500000, balanceCents: 400000, campaign: "CAPITAL2026", anniversaryDate: utcMidnight(2026, 11, 10), fiveDayReminderDate: utcMidnight(2026, 11, 5) },
    ];
    const events = buildAnnualRenewalReminderEvents(rows, identityByDonor, TZ, now);
    assert.equal(events.length, 3, "plan A contributes 1 (its five-day mark already passed) and plan B contributes 2 (both stages inside the window) = 3");
    const ids = events.map((e) => e.id);
    assert.equal(new Set(ids).size, 3, "event ids must never collide between two different plans, or between a plan's own two stages");
    assert.ok(events.every((e) => e.type === "annual_pledge_renewal"));

    const onDay = events.find((e) => e.id === "annual-pledge-renewal:plan-a:anniversary");
    const planBApproaching = events.find((e) => e.id === "annual-pledge-renewal:plan-b:approaching");
    const planBAnniversary = events.find((e) => e.id === "annual-pledge-renewal:plan-b:anniversary");
    assert.ok(onDay && planBApproaching && planBAnniversary);

    // --- Exact required titles, verbatim. ---
    assert.equal(onDay.relationshipPhrase, "Annual pledge renewal opportunity");
    assert.equal(planBApproaching.relationshipPhrase, "Annual pledge renewal approaching");
    assert.equal(planBAnniversary.relationshipPhrase, "Annual pledge renewal opportunity");

    // --- 3: the correct FUTURE event date is shown, never today's date
    // -- dateEpoch (bucketing/sort) is the stage's own real date; dateLabel
    // (what's rendered) is always the anniversary date itself (the thing
    // being prepared for/acted on), matching buildPaymentPlanMilestoneEvents'
    // own "target date, not firing date" precedent. ---
    assert.equal(onDay.dateEpoch, todayEpoch, "plan A's anniversary fires today");
    assert.equal(onDay.dateLabel, "Nov 1, 2026");
    assert.equal(planBApproaching.dateEpoch, utcMidnight(2026, 11, 5), "plan B's approaching stage carries ITS OWN real date, not today's");
    assert.notEqual(planBApproaching.dateEpoch, todayEpoch);
    assert.equal(planBApproaching.dateLabel, "Nov 10, 2026", "dateLabel always shows the anniversary itself, even for the approaching stage");
    assert.equal(planBAnniversary.dateEpoch, utcMidnight(2026, 11, 10));
    assert.equal(planBAnniversary.dateLabel, "Nov 10, 2026");

    // --- 5: no duplicate entries between Today and Coming Up -- every
    // event lands in exactly one of the two partitioned buckets. ---
    const { today: todayBucket, upcoming: upcomingBucket } = partitionRelationshipDateEventsByToday(events, now, TZ);
    assert.deepEqual(todayBucket.map((e) => e.id).sort(), ["annual-pledge-renewal:plan-a:anniversary"]);
    assert.deepEqual(upcomingBucket.map((e) => e.id).sort(), ["annual-pledge-renewal:plan-b:anniversary", "annual-pledge-renewal:plan-b:approaching"]);
    assert.equal(todayBucket.length + upcomingBucket.length, events.length, "every event lands in exactly one bucket -- none dropped, none duplicated");

    // --- 8/11: upcoming-window boundary -- exactly 14 days out still
    // qualifies, 15 days out does not (RELATIONSHIP_DATE_LEAD_WINDOW_DAYS). ---
    const boundaryRow = { donorId: "donor-1", planId: "plan-c", pledgeActivityId: "pledge-c", originalPledgeDate: utcMidnight(2025, 11, 15), originalPledgeAmountCents: 100000, balanceCents: 0, campaign: null, anniversaryDate: utcMidnight(2026, 11, 15), fiveDayReminderDate: utcMidnight(2026, 11, 10) };
    const exactly14Out = buildAnnualRenewalReminderEvents([boundaryRow], identityByDonor, TZ, now);
    assert.equal(exactly14Out.filter((e) => e.id.endsWith(":anniversary")).length, 1, "exactly 14 days out must still appear in the upcoming window");
    const beyond14 = { ...boundaryRow, planId: "plan-d", anniversaryDate: utcMidnight(2026, 11, 16), fiveDayReminderDate: utcMidnight(2026, 11, 11) };
    const exactly15Out = buildAnnualRenewalReminderEvents([beyond14], identityByDonor, TZ, now);
    assert.equal(exactly15Out.filter((e) => e.id.endsWith(":anniversary")).length, 0, "15 days out must NOT appear yet -- beyond the 14-day lead window");

    // --- A date that has already passed (e.g. a plan picked up after its
    // five-day mark already fired, with no anniversary reminder shown
    // yet) must never retroactively reappear. ---
    const alreadyPassed = { ...rows[0], planId: "plan-e", anniversaryDate: utcMidnight(2026, 10, 20), fiveDayReminderDate: utcMidnight(2026, 10, 15) };
    const pastEvents = buildAnnualRenewalReminderEvents([alreadyPassed], identityByDonor, TZ, now);
    assert.equal(pastEvents.length, 0, "a stage date before today must never fire retroactively");

    // --- 10/4: multiple plans for one donor remain independently
    // evaluated with the window fix in place (same guarantee as before,
    // re-verified after the windowing change). ---
    assert.ok(new Set(events.map((e) => e.id.split(":")[1])).size >= 2, "events must span more than one plan id for this multi-plan donor");

    // --- Required reminder information: donor name, original pledge
    // amount, campaign, outstanding balance are all present. ---
    assert.match(onDay.secondaryDateLabel, /\$1,200\.00 pledged \(GENOP2025\)/);
    assert.match(onDay.secondaryDateLabel, /\$100\.00 balance remaining/);
    assert.equal(onDay.donorName, "Mr. & Mrs. Test Donor");
    assert.equal(onDay.donorCode, "12345");

    // --- 14/15: outstanding balance vs. fully paid -- neither suppresses
    // the event; balance is shown as context either way. ---
    const fullyPaidRows = [{ ...rows[0], balanceCents: 0 }];
    const fullyPaidEvents = buildAnnualRenewalReminderEvents(fullyPaidRows, identityByDonor, TZ, now);
    assert.equal(fullyPaidEvents.length, 1, "a fully paid commitment must still generate its own first-anniversary reminder -- not automatically treated as irrelevant");
    assert.match(fullyPaidEvents[0].secondaryDateLabel, /\$0\.00 balance remaining/);

    // --- A donor with no identity row is silently skipped (matches every
    // other builder in this file -- Coming Up never shows a card it
    // can't fully populate). ---
    const noIdentity = buildAnnualRenewalReminderEvents(rows, new Map(), TZ, now);
    assert.equal(noIdentity.length, 0);

    // --- Campaign absent (null) must still render a complete, valid
    // line -- never a literal "(null)" or broken parens. ---
    const noCampaignRows = [{ ...rows[0], campaign: null }];
    const noCampaignEvents = buildAnnualRenewalReminderEvents(noCampaignRows, identityByDonor, TZ, now);
    assert.doesNotMatch(noCampaignEvents[0].secondaryDateLabel, /null/);
    assert.match(noCampaignEvents[0].secondaryDateLabel, /^\$1,200\.00 pledged · /);
  }

  // ============================================================
  // 18/20: coexistence with the existing 15/10/5-day final-payment
  // milestone -- the two are independent computations over independent
  // inputs (finalExpectedPaymentAt vs. originalPledgeDate); evaluating
  // one must never change the other's result for the same plan.
  // ============================================================
  {
    const plan = { nextExpectedPaymentAt: utcMidnight(2026, 9, 24), expectedDayOfMonth: 24, finalExpectedPaymentAt: utcMidnight(2026, 10, 24), endedAt: null };
    const { evaluatePaymentPlan } = await import("../lib/relationships/pledge-payment-plan.ts");
    const milestoneResult = evaluatePaymentPlan(plan, [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)], 2000, et(2026, 10, 9), TZ);
    assert.equal(milestoneResult.milestoneDaysBefore, 15, "the existing final-payment milestone must still fire normally");
    // Same plan, now ALSO evaluated for annual renewal with an unrelated
    // original pledge date -- must not interfere with the milestone
    // result computed just above (same plan object, re-evaluated, no
    // shared mutable state).
    const renewalResult = evaluateAnnualRenewal(utcMidnight(2025, 10, 9), plan.endedAt, et(2026, 10, 9), TZ);
    assert.equal(renewalResult.isAnniversaryReminder, true, "the annual renewal can independently fire for the same plan on the same day");
    const milestoneResultAgain = evaluatePaymentPlan(plan, [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)], 2000, et(2026, 10, 9), TZ);
    assert.deepEqual(milestoneResultAgain, milestoneResult, "evaluating annual renewal must never change the final-payment milestone's own result for the same plan");
  }

  // ============================================================
  // Route wiring -- create and edit routes, structural checks (this
  // repo's established "no D1/env test harness for routes" convention).
  // ============================================================
  {
    const createRoute = fs.readFileSync(new URL("../app/api/pledge-payment-plans/route.ts", import.meta.url), "utf8");
    assert.match(createRoute, /validateOriginalPledgeDate\(body\.originalPledgeDate, createdAtForAnchor, profile\.timezone\)/, "the create route must validate originalPledgeDate the same way as every other date field");
    assert.match(createRoute, /original_pledge_date/, "the create route's INSERT must include original_pledge_date");
    assert.match(createRoute, /"originalPledgeDate"/, "the create route's audit changedFields must record originalPledgeDate");

    const editRoute = fs.readFileSync(new URL("../app/api/pledge-payment-plans/[id]/route.ts", import.meta.url), "utf8");
    assert.match(editRoute, /Object\.hasOwn\(body, "originalPledgeDate"\)/, "the edit route must gate on presence, distinguishing 'leave unchanged' from 'explicit clear', same convention as every other optional edit field");
    assert.match(editRoute, /validateOriginalPledgeDate\(body\.originalPledgeDate, now, profile\.timezone\)/);
    assert.match(editRoute, /original_pledge_date = \?/, "the edit route's UPDATE must include original_pledge_date");
  }

  console.log("pledge-payment-plan-annual-renewal: ok");
}

await run();
