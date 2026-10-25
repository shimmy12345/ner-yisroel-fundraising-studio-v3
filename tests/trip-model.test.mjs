import assert from "node:assert/strict";
import {
  TRIP_STATUSES, isValidTripStatus, TRIP_PROSPECT_STATUSES, isValidProspectStatus,
  statusRequiresInteraction, isConflictingProspectStatus, findCrossTripConflicts,
  buildSuggestionSnapshot, timezoneForState, parseLocalDateTimeInput,
  tripScheduledInteractionSource, tripCompletedInteractionSource, tripCancelledInteractionSource, tripMeetingInteractionId,
  validateTripName, validateTripDates, validateFundraisingGoalCents, validateNotes, validateMeetingLocation, validateNextAction,
  validateMeetingCompletion, validateMeetingScheduling,
  matchExistingGivingActivityForCommitment, validateDestinationRegionIds,
} from "../lib/relationships/trip-model.ts";
import { activityStatus, completedPlannedAt, originalActivitySource, isScheduledActivity, isCancelledActivity } from "../lib/workspace/scheduled-activity.ts";
import { zonedTimeToUtc } from "../lib/workspace/local-time.ts";

// Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md).
// Exercises the pure logic directly -- lib/relationships/trips-data.ts's
// D1-touching functions have no direct unit test here, matching this
// codebase's own established convention (lib/agenda/gmail-client.ts's own
// header comment: Workers-only, cannot be imported outside a Workers
// runtime, exercised via live verification instead). Staging deployment
// and read-only/disposable-test-data verification cover that side.

const NOW = 1760400000; // fixed "now", consistent with other test files this session

async function run() {
  // --- Status taxonomies: exactly the approved sets, nothing more. ---
  assert.deepEqual([...TRIP_STATUSES], ["planning", "active", "completed", "cancelled"]);
  assert.equal(isValidTripStatus("active"), true);
  assert.equal(isValidTripStatus("archived"), false);
  assert.equal(isValidTripStatus(123), false);

  assert.deepEqual([...TRIP_PROSPECT_STATUSES], ["not_contacted", "contacted", "meeting_requested", "meeting_scheduled", "meeting_completed", "declined", "unable_to_schedule"]);
  assert.equal(isValidProspectStatus("meeting_scheduled"), true);
  assert.equal(isValidProspectStatus("maybe"), false);

  // --- Interaction safeguards (Section D): only these two statuses ever
  // touch a real interaction. "Contacted" in particular must never
  // require/imply one. ---
  assert.equal(statusRequiresInteraction("meeting_scheduled"), true);
  assert.equal(statusRequiresInteraction("meeting_completed"), true);
  for (const status of ["not_contacted", "contacted", "meeting_requested", "declined", "unable_to_schedule"]) {
    assert.equal(statusRequiresInteraction(status), false, `${status} must never require a real interaction`);
  }

  // --- Cross-trip conflicts (Section C): a caution, scoped to exactly
  // the two statuses that represent a genuinely still-pending meeting
  // plan; never the donor's own row on the trip being viewed. ---
  assert.equal(isConflictingProspectStatus("meeting_requested"), true);
  assert.equal(isConflictingProspectStatus("meeting_scheduled"), true);
  for (const status of ["not_contacted", "contacted", "meeting_completed", "declined", "unable_to_schedule"]) {
    assert.equal(isConflictingProspectStatus(status), false, `${status} must not count as a scheduling conflict`);
  }
  {
    const rows = [
      { tripId: "trip-a", tripName: "Chicago Nov", status: "meeting_scheduled", meetingAt: NOW + 86400 },
      { tripId: "trip-b", tripName: "Baltimore Dec", status: "declined", meetingAt: null },
      { tripId: "trip-c", tripName: "This Same Trip", status: "meeting_requested", meetingAt: null },
    ];
    const conflicts = findCrossTripConflicts(rows, "trip-c");
    assert.deepEqual(conflicts.map((c) => c.tripId), ["trip-a"], "only the genuinely conflicting OTHER trip is returned -- declined doesn't conflict, and the current trip excludes itself");
  }

  // --- Suggestion snapshot (Section B's independent-review refinement):
  // a real recommendation produces a concrete reason/score/generatedAt;
  // no evidence at all still produces a neutral, honest reason rather
  // than manufacturing urgency -- never null/undefined/blank. ---
  {
    const recommendation = { action: "Follow up on the open $5,000 pledge.", why: "No payment activity in 70 days.", evidence: [], confidence: "medium", timing: null, kind: "follow_up_pledge", score: 0.42 };
    const snapshot = buildSuggestionSnapshot(recommendation, NOW);
    assert.match(snapshot.reason, /\$5,000 pledge/);
    assert.equal(snapshot.score, 0.42);
    assert.equal(snapshot.generatedAt, NOW);
  }
  {
    const snapshot = buildSuggestionSnapshot(null, NOW);
    assert.ok(snapshot.reason && snapshot.reason.length > 0, "a donor with no actionable evidence still gets a real, non-empty, honest reason");
    assert.doesNotMatch(snapshot.reason, /overdue|urgent|asap/i, "the neutral fallback must never manufacture urgency");
    assert.equal(snapshot.score, null, "no evidence means no invented score");
    assert.equal(snapshot.generatedAt, NOW, "the generation date is always recorded, even for the neutral case");
  }

  // --- Destination timezone handling: every state that actually appears
  // in the 15 approved travel regions resolves to a real IANA zone;
  // an unrecognized or missing state falls back to the caller's own
  // home timezone, never a guess. ---
  assert.equal(timezoneForState("IL", "America/New_York"), "America/Chicago");
  assert.equal(timezoneForState("CA", "America/New_York"), "America/Los_Angeles");
  assert.equal(timezoneForState("il", "America/New_York"), "America/Chicago", "case-insensitive");
  assert.equal(timezoneForState("ZZ", "America/New_York"), "America/New_York", "unrecognized state falls back, never guesses");
  assert.equal(timezoneForState(null, "America/New_York"), "America/New_York");

  // --- parseLocalDateTimeInput: strict parsing of exactly the format an
  // <input type="datetime-local"> always produces (independent-review
  // correction, 2026-10-15 -- the live scheduling flow originally parsed
  // this text with the browser's own `Date()` constructor, which reads
  // the DEVICE's ambient timezone, not the destination's). Never `new
  // Date()` -- a strict regex, so malformed or unexpected input is
  // rejected rather than silently misinterpreted. ---
  assert.deepEqual(parseLocalDateTimeInput("2026-11-05T14:30"), { year: 2026, month: 11, day: 5, hour: 14, minute: 30 });
  assert.equal(parseLocalDateTimeInput("not-a-date"), null);
  assert.equal(parseLocalDateTimeInput("2026-11-05"), null, "a bare date with no time must be rejected, never silently treated as midnight");
  assert.equal(parseLocalDateTimeInput("2026-13-05T14:30"), null, "month 13 is invalid");
  assert.equal(parseLocalDateTimeInput("2026-11-05T25:30"), null, "hour 25 is invalid");
  assert.equal(parseLocalDateTimeInput(null), null);
  assert.equal(parseLocalDateTimeInput(undefined), null);
  assert.equal(parseLocalDateTimeInput(1760400000), null, "a raw epoch number must never be accepted as if it were the local-datetime text format");

  // --- Real end-to-end composition: parseLocalDateTimeInput() +
  // timezoneForState() + the REAL, unmodified zonedTimeToUtc()
  // (lib/workspace/local-time.ts) -- proving DST is actually handled
  // correctly, not merely that each piece works in isolation. The same
  // wall-clock time (2:00 PM) at the same destination (a Chicago-area
  // donor) must resolve to a DIFFERENT UTC instant in winter (CST,
  // UTC-6) than in summer (CDT, UTC-5) -- if DST were not genuinely
  // applied, both would incorrectly share one fixed offset. This is the
  // actual proof the live scheduling flow (trips-data.ts's
  // resolveMeetingEpoch(), which composes these same three pieces) gets
  // a destination meeting time right across the year, not just that
  // timezoneForState() returns the right zone NAME in isolation. ---
  {
    const timezone = timezoneForState("IL", "America/New_York");
    assert.equal(timezone, "America/Chicago");

    const winterFields = parseLocalDateTimeInput("2026-01-15T14:00");
    const winterUtc = zonedTimeToUtc(winterFields.year, winterFields.month, winterFields.day, winterFields.hour, winterFields.minute, timezone);
    assert.equal(winterUtc.getUTCHours(), 20, "2:00 PM CST (winter, UTC-6) must resolve to 8:00 PM UTC");

    const summerFields = parseLocalDateTimeInput("2026-07-15T14:00");
    const summerUtc = zonedTimeToUtc(summerFields.year, summerFields.month, summerFields.day, summerFields.hour, summerFields.minute, timezone);
    assert.equal(summerUtc.getUTCHours(), 19, "2:00 PM CDT (summer, UTC-5) must resolve to 7:00 PM UTC -- a full hour different from winter, proving DST is actually applied");
  }

  // --- Interaction source-string builders: verified against the REAL,
  // unmodified lib/workspace/scheduled-activity.ts functions that the
  // rest of the CRM already uses to derive activity status -- this is
  // the actual proof that a trip meeting is indistinguishable, to every
  // other surface, from any other scheduled/completed/cancelled
  // activity, not merely that these builders return SOME string. ---
  {
    const tripId = "trip-123";
    const scheduledSource = tripScheduledInteractionSource(tripId);
    const plannedAt = NOW + 86400;
    const createdAt = NOW;
    assert.equal(isScheduledActivity(scheduledSource, plannedAt, createdAt), true, "a freshly scheduled trip meeting must be recognized as a real scheduled activity");
    assert.equal(activityStatus(scheduledSource, plannedAt, createdAt), "scheduled");

    const completedAt = plannedAt;
    const completedSource = tripCompletedInteractionSource(plannedAt, scheduledSource);
    assert.equal(activityStatus(completedSource, completedAt, createdAt), "completed", "a completed trip meeting must be recognized as a real completed activity");
    assert.equal(completedPlannedAt(completedSource), plannedAt, "the original planned time must still be recoverable");
    assert.equal(originalActivitySource(completedSource), scheduledSource, "the original scheduled source must still be recoverable (e.g. if the meeting is reopened)");

    const cancelledSource = tripCancelledInteractionSource(scheduledSource);
    assert.equal(isCancelledActivity(cancelledSource), true, "a cancelled trip meeting must be recognized as cancelled");
    assert.equal(isScheduledActivity(cancelledSource, plannedAt, createdAt), false, "a cancelled trip meeting must NOT still show up as an upcoming scheduled activity anywhere in the CRM");
    assert.equal(activityStatus(cancelledSource, plannedAt, createdAt), "cancelled");
    // Wrapping an already-cancelled source a second time must not
    // double-wrap it (matching lib/workspace/scheduled-activity.ts's own
    // exact convention for this, reused verbatim).
    assert.equal(tripCancelledInteractionSource(cancelledSource), cancelledSource);
  }

  // --- Deterministic interaction id: the SAME prospect always maps to
  // the SAME interaction id -- this is what prevents a retried/refreshed
  // request from ever creating a duplicate interaction. ---
  assert.equal(tripMeetingInteractionId("prospect-abc"), tripMeetingInteractionId("prospect-abc"));
  assert.notEqual(tripMeetingInteractionId("prospect-abc"), tripMeetingInteractionId("prospect-xyz"));

  // --- Validators (same { ok: true; ... } | { ok: false } shape
  // lib/capture/ask.ts's own validators already use). ---
  assert.equal(validateTripName("  Chicago -- November 2026  ").ok, true);
  assert.equal(validateTripName("").ok, false);
  assert.equal(validateTripName("x".repeat(201)).ok, false);

  assert.equal(validateTripDates(NOW, NOW + 86400 * 5).ok, true);
  assert.equal(validateTripDates(NOW, NOW - 86400).ok, false, "end before start must fail");
  assert.equal(validateTripDates(NOW, NOW + 86400 * 365).ok, false, "an implausibly long span must fail");
  assert.equal(validateTripDates("not-a-number", NOW).ok, false);

  assert.deepEqual(validateFundraisingGoalCents(undefined), { ok: true, goalCents: null });
  assert.deepEqual(validateFundraisingGoalCents(null), { ok: true, goalCents: null });
  assert.equal(validateFundraisingGoalCents(2500000).ok, true);
  assert.equal(validateFundraisingGoalCents(-5).ok, false);
  assert.equal(validateFundraisingGoalCents(1.5).ok, false);

  assert.deepEqual(validateNotes(undefined), { ok: true, notes: null });
  assert.equal(validateNotes("x".repeat(5001)).ok, false);
  assert.equal(validateMeetingLocation("x".repeat(301)).ok, false);
  assert.equal(validateNextAction("x".repeat(501)).ok, false);

  // "Marking a meeting Completed must require ... an actual meeting date
  // and meaningful notes" -- both halves enforced.
  assert.equal(validateMeetingCompletion(NOW, "Discussed the building campaign.", NOW).ok, true);
  assert.equal(validateMeetingCompletion(NOW + 3600, "Fine.", NOW).ok, false, "a completion time more than 5 minutes in the future must be rejected");
  assert.equal(validateMeetingCompletion(NOW, "x", NOW).ok, false, "a single character is not meaningful notes");
  assert.equal(validateMeetingCompletion(NOW, "", NOW).ok, false);
  assert.equal(validateMeetingCompletion(NOW, "x".repeat(5001), NOW).ok, false);

  // "Scheduling a meeting ... only after explicit user confirmation" --
  // this validator enforces the one hard requirement (a real future
  // time); the explicit confirmation flag itself is checked by the
  // caller (lib/relationships/trips-data.ts's scheduleProspectMeeting).
  assert.equal(validateMeetingScheduling(NOW + 86400, NOW).ok, true);
  assert.equal(validateMeetingScheduling(NOW - 1, NOW).ok, false, "a past meeting time must be rejected for scheduling -- that is what Marking Completed is for");
  assert.equal(validateMeetingScheduling(NOW, NOW).ok, false, "the exact current moment is not in the future");

  // --- matchExistingGivingActivityForCommitment (2026-10-26, see
  // docs/AI-HANDOFF.md's "Verification: Manual-Prospect JL Duplicate
  // Risk" entry) -- the JL-duplicate fix's own matching logic. ---
  {
    const pledgeCommitment = { category: "pending_pledge", committedCents: 500000, activityDate: NOW };

    // No candidates at all -- falls back to creating a pending record.
    assert.equal(matchExistingGivingActivityForCommitment(pledgeCommitment, []), null);

    // Exactly one unambiguous real match -- the common "already imported
    // from JL before linking" case this fix exists for.
    const onePledgeMatch = [{ id: "ga-1", category: "open_pledge", committedCents: 500000, activityDate: NOW }];
    assert.deepEqual(matchExistingGivingActivityForCommitment(pledgeCommitment, onePledgeMatch), onePledgeMatch[0]);
    // partially_paid_pledge matches too -- committed_cents is stable
    // across partial payments, unlike paid_cents/balance_cents.
    const onePartiallyPaidMatch = [{ id: "ga-2", category: "partially_paid_pledge", committedCents: 500000, activityDate: NOW }];
    assert.deepEqual(matchExistingGivingActivityForCommitment(pledgeCommitment, onePartiallyPaidMatch), onePartiallyPaidMatch[0]);

    // A pending_pledge must never match a completed_gift, even with the
    // exact same amount and date -- a gift and a pledge are different
    // kinds of commitment.
    assert.equal(matchExistingGivingActivityForCommitment(pledgeCommitment, [{ id: "ga-3", category: "completed_gift", committedCents: 500000, activityDate: NOW }]), null);
    const giftCommitment = { category: "pending_gift", committedCents: 500000, activityDate: NOW };
    assert.equal(matchExistingGivingActivityForCommitment(giftCommitment, [{ id: "ga-4", category: "open_pledge", committedCents: 500000, activityDate: NOW }]), null);
    assert.deepEqual(matchExistingGivingActivityForCommitment(giftCommitment, [{ id: "ga-5", category: "completed_gift", committedCents: 500000, activityDate: NOW }]), { id: "ga-5", category: "completed_gift", committedCents: 500000, activityDate: NOW });

    // A different amount, or a date outside the window, is not a match.
    assert.equal(matchExistingGivingActivityForCommitment(pledgeCommitment, [{ id: "ga-6", category: "open_pledge", committedCents: 400000, activityDate: NOW }]), null);
    assert.equal(matchExistingGivingActivityForCommitment(pledgeCommitment, [{ id: "ga-7", category: "open_pledge", committedCents: 500000, activityDate: NOW + 8 * 86400 }]), null, "outside the 7-day default window");
    assert.deepEqual(matchExistingGivingActivityForCommitment(pledgeCommitment, [{ id: "ga-8", category: "open_pledge", committedCents: 500000, activityDate: NOW + 6 * 86400 }]), { id: "ga-8", category: "open_pledge", committedCents: 500000, activityDate: NOW + 6 * 86400 }, "inside the window, on the later side");

    // A commitment with no activity date (should never happen in
    // practice -- pendingGiftInput/pendingPledgeInput already require
    // one -- but defensively) never auto-matches.
    assert.equal(matchExistingGivingActivityForCommitment({ category: "pending_pledge", committedCents: 500000, activityDate: null }, onePledgeMatch), null);

    // Two plausible real candidates -- deliberately ambiguous, never
    // auto-picked. Same "never automatically match solely by donor and
    // amount where multiple records could qualify" rule
    // attributeGivingActivityToTrip's own ambiguous-match guard enforces.
    assert.equal(matchExistingGivingActivityForCommitment(pledgeCommitment, [
      { id: "ga-9", category: "open_pledge", committedCents: 500000, activityDate: NOW },
      { id: "ga-10", category: "partially_paid_pledge", committedCents: 500000, activityDate: NOW + 86400 },
    ]), null, "multiple plausible matches must never be auto-resolved");
  }

  // --- validateDestinationRegionIds (2026-10-26, see docs/AI-HANDOFF.md's
  // "Multi-Region Trip Destination" entry). ---
  {
    const isValidTestRegion = (candidate) => ["a", "b", "c"].includes(candidate);
    assert.deepEqual(validateDestinationRegionIds(undefined, isValidTestRegion), { ok: true, regionIds: [] }, "omitted means no region, same as before this round");
    assert.deepEqual(validateDestinationRegionIds(null, isValidTestRegion), { ok: true, regionIds: [] });
    assert.deepEqual(validateDestinationRegionIds([], isValidTestRegion), { ok: true, regionIds: [] }, "an explicit empty array is a legitimate 'no region' choice");
    assert.deepEqual(validateDestinationRegionIds(["a"], isValidTestRegion), { ok: true, regionIds: ["a"] });
    assert.deepEqual(validateDestinationRegionIds(["a", "b", "c"], isValidTestRegion), { ok: true, regionIds: ["a", "b", "c"] }, "any combination of regions is accepted");
    assert.equal(validateDestinationRegionIds(["a", "z"], isValidTestRegion).ok, false, "an unapproved region id must be rejected");
    assert.equal(validateDestinationRegionIds(["a", "a"], isValidTestRegion).ok, false, "a repeated region id must be rejected");
    assert.equal(validateDestinationRegionIds("a", isValidTestRegion).ok, false, "a bare string (not an array) must be rejected");
    assert.equal(validateDestinationRegionIds([1], isValidTestRegion).ok, false, "a non-string entry must be rejected");
    assert.equal(validateDestinationRegionIds(["a", "b", "c", "a"], isValidTestRegion).ok, false);
  }

  console.log("trip-model: ok");
}

await run();
