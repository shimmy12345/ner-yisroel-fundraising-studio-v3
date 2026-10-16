import assert from "node:assert/strict";
import { followUpFromSuggestion, emptyFollowUp, selectApprovedFollowUps, findUnresolvedApprovedFollowUps } from "../lib/meeting-notes/follow-ups.ts";

// Meeting date used throughout: Thursday, 2026-10-15 (see
// tests/meeting-notes-due-date-resolver.test.mjs for the date-arithmetic
// coverage itself; these tests cover how follow-ups.ts wires the
// resolver's output into FollowUpRow).
const MEETING_DATE = "2026-10-15";

// --- Every follow-up, AI-proposed or manually added, starts unapproved ---

{
  // A relative phrase that resolves to an exact date -- tagged
  // "ai-resolved" so the review screen can label it as computed, not
  // something the donor/fundraiser stated outright.
  const row = followUpFromSuggestion({ description: "Call donor", suggestedDueDate: "next Monday" }, "id-1", MEETING_DATE);
  assert.equal(row.approved, false, "an AI-proposed follow-up must start unapproved");
  assert.equal(row.description, "Call donor", "description is left untouched -- no more folding the phrase into it");
  assert.equal(row.dueAt, "2026-10-19");
  assert.equal(row.dueDateSource, "ai-resolved");
  assert.equal(row.aiPhrase, "next Monday", "the original wording must still be visible");
  assert.equal(row.confirmedUnscheduled, false);
}
{
  // A literal calendar date actually stated in the conversation --
  // tagged "explicit", distinct from a computed relative phrase.
  const row = followUpFromSuggestion({ description: "Send the pledge form", suggestedDueDate: "November 3rd" }, "id-2", MEETING_DATE);
  assert.equal(row.dueAt, "2026-11-03");
  assert.equal(row.dueDateSource, "explicit");
  assert.equal(row.aiPhrase, "November 3rd");
}
{
  const row = followUpFromSuggestion({ description: "No date suggested", suggestedDueDate: null }, "id-3", MEETING_DATE);
  assert.equal(row.approved, false);
  assert.equal(row.dueAt, "", "a null suggestedDueDate becomes an empty editable date field, never invented");
  assert.equal(row.dueDateSource, "unset");
  assert.equal(row.aiPhrase, null);
}

// --- A relative-timeframe suggestion that cannot be reliably resolved
// (ambiguous wording, or a Jewish-calendar reference) must never invent a
// precise date, but the original wording must still be visible to the
// fundraiser rather than silently discarded -- confirmed live, Workers AI
// returned exactly this shape (suggestedDueDate: "early next week") for a
// transcript whose only due-date language was relative. ---

{
  const row = followUpFromSuggestion({ description: "Follow up about the dinner sponsorship", suggestedDueDate: "early next week" }, "id-4", MEETING_DATE);
  assert.equal(row.dueAt, "", "an unresolved suggestion must leave the date field empty, not an unparseable string");
  assert.equal(row.description, "Follow up about the dinner sponsorship", "description is no longer mutated -- the phrase lives in aiPhrase instead");
  assert.equal(row.dueDateSource, "unset");
  assert.equal(row.aiPhrase, "early next week", "the relative timeframe must still be visible to the fundraiser, not silently dropped");
  assert.equal(row.approved, false);
}
{
  const row = followUpFromSuggestion({ description: "Follow up after the holiday", suggestedDueDate: "after Yom Tov" }, "id-5", MEETING_DATE);
  assert.equal(row.dueAt, "", "a Jewish-calendar reference must never be guessed at");
  assert.equal(row.dueDateSource, "unset");
  assert.equal(row.aiPhrase, "after Yom Tov");
}

{
  const row = emptyFollowUp("id-6");
  assert.equal(row.approved, false, "a manually-added follow-up must also start unapproved");
  assert.equal(row.description, "");
  assert.equal(row.dueDateSource, "unset");
  assert.equal(row.aiPhrase, null);
  assert.equal(row.confirmedUnscheduled, false);
}

// --- selectApprovedFollowUps: the save gate (unchanged wire format --
// dueDateSource/aiPhrase/confirmedUnscheduled are UI-only and never sent
// to the save route) ---

const rows = [
  { id: "a", description: "Approved task", dueAt: "2026-11-01", approved: true },
  { id: "b", description: "Unapproved task", dueAt: "2026-11-02", approved: false },
  { id: "c", description: "   ", dueAt: "", approved: true }, // approved but blank -- must still be dropped
  { id: "d", description: "No due date, approved", dueAt: "", approved: true },
];
const selected = selectApprovedFollowUps(rows);
assert.deepEqual(selected, [
  { description: "Approved task", dueAt: "2026-11-01" },
  { description: "No due date, approved", dueAt: null },
], "only approved rows with real text are selected; unapproved and blank-but-approved rows are dropped; an empty date becomes null, not an empty string");

// A row the fundraiser edited after approving (description/date changed)
// is selected with its EDITED content, not the original AI suggestion --
// selectApprovedFollowUps only ever looks at the row's current state.
{
  const edited = followUpFromSuggestion({ description: "Original AI text", suggestedDueDate: null }, "id-7", MEETING_DATE);
  edited.approved = true;
  edited.description = "Fundraiser's edited version";
  edited.dueAt = "2026-12-25";
  assert.deepEqual(selectApprovedFollowUps([edited]), [{ description: "Fundraiser's edited version", dueAt: "2026-12-25" }]);
}

assert.deepEqual(selectApprovedFollowUps([]), []);

// --- findUnresolvedApprovedFollowUps: "never silently save an undated
// follow-up that was intended to be scheduled" -- requires the
// fundraiser to either pick a date or explicitly confirm "no date
// needed" before an approved, undated row may be saved. ---

{
  // Approved + no date + not confirmed unscheduled -> blocked.
  const blocked = { id: "x", description: "Needs a date", dueAt: "", approved: true, dueDateSource: "unset", aiPhrase: "early next week", confirmedUnscheduled: false };
  assert.deepEqual(findUnresolvedApprovedFollowUps([blocked]), ["x"]);
}
{
  // Approved + no date + explicitly confirmed unscheduled -> allowed.
  const confirmed = { id: "y", description: "Intentionally open-ended", dueAt: "", approved: true, dueDateSource: "unset", aiPhrase: null, confirmedUnscheduled: true };
  assert.deepEqual(findUnresolvedApprovedFollowUps([confirmed]), []);
}
{
  // Approved + has a date -> never blocked, regardless of confirmedUnscheduled.
  const dated = { id: "z", description: "Has a date", dueAt: "2026-11-01", approved: true, dueDateSource: "ai-resolved", aiPhrase: "tomorrow", confirmedUnscheduled: false };
  assert.deepEqual(findUnresolvedApprovedFollowUps([dated]), []);
}
{
  // Unapproved rows are never blocked -- they're not being saved at all.
  const unapproved = { id: "w", description: "Not approved", dueAt: "", approved: false, dueDateSource: "unset", aiPhrase: null, confirmedUnscheduled: false };
  assert.deepEqual(findUnresolvedApprovedFollowUps([unapproved]), []);
}
{
  // Approved but blank description -- never reaches save anyway
  // (selectApprovedFollowUps drops it), so it must not be flagged either.
  const blank = { id: "v", description: "   ", dueAt: "", approved: true, dueDateSource: "unset", aiPhrase: null, confirmedUnscheduled: false };
  assert.deepEqual(findUnresolvedApprovedFollowUps([blank]), []);
}
{
  // Multiple offending rows are all reported, in order, so the UI can
  // highlight every one that needs attention, not just the first.
  const a = { id: "p", description: "First", dueAt: "", approved: true, dueDateSource: "unset", aiPhrase: null, confirmedUnscheduled: false };
  const b = { id: "q", description: "Second", dueAt: "2026-11-01", approved: true, dueDateSource: "manual", aiPhrase: null, confirmedUnscheduled: false };
  const c = { id: "r", description: "Third", dueAt: "", approved: true, dueDateSource: "unset", aiPhrase: "soon", confirmedUnscheduled: false };
  assert.deepEqual(findUnresolvedApprovedFollowUps([a, b, c]), ["p", "r"]);
}

console.log("meeting-notes-followups.test.mjs: all assertions passed");
