import assert from "node:assert/strict";
import { followUpFromSuggestion, emptyFollowUp, selectApprovedFollowUps } from "../lib/meeting-notes/follow-ups.ts";

// --- Every follow-up, AI-proposed or manually added, starts unapproved ---

{
  const row = followUpFromSuggestion({ description: "Call donor after Yom Tov", suggestedDueDate: "2026-11-01" }, "id-1");
  assert.equal(row.approved, false, "an AI-proposed follow-up must start unapproved");
  assert.equal(row.description, "Call donor after Yom Tov");
  assert.equal(row.dueAt, "2026-11-01");
}
{
  const row = followUpFromSuggestion({ description: "No date suggested", suggestedDueDate: null }, "id-2");
  assert.equal(row.approved, false);
  assert.equal(row.dueAt, "", "a null suggestedDueDate becomes an empty editable date field, never invented");
}
{
  const row = emptyFollowUp("id-3");
  assert.equal(row.approved, false, "a manually-added follow-up must also start unapproved");
  assert.equal(row.description, "");
}

// --- selectApprovedFollowUps: the save gate ---

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
  const edited = followUpFromSuggestion({ description: "Original AI text", suggestedDueDate: null }, "id-4");
  edited.approved = true;
  edited.description = "Fundraiser's edited version";
  edited.dueAt = "2026-12-25";
  assert.deepEqual(selectApprovedFollowUps([edited]), [{ description: "Fundraiser's edited version", dueAt: "2026-12-25" }]);
}

// Removing a row (simulated by simply not including it) means it is never
// selected regardless of its approved state -- there is nothing special
// to test here beyond "selectApprovedFollowUps only sees what's passed
// in," but this documents the expectation explicitly.
assert.deepEqual(selectApprovedFollowUps([]), []);

console.log("meeting-notes-followups.test.mjs: all assertions passed");
