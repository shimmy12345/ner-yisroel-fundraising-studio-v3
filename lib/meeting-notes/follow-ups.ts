// Follow-up approval rules shared by MeetingNotesExperience.tsx
// (docs/AI-HANDOFF.md, "Meeting Notes Final Safeguards and AI
// Readiness"). Pure and UI-free so the "every follow-up starts
// unapproved, and only approved ones with real text are ever sent to
// save" rule is independently testable, not just eyeballed in the
// component.

import type { OrganizedFollowUp } from "./organize";

export type FollowUpRow = { id: string; description: string; dueAt: string; approved: boolean };

// dueAt feeds a plain <input type="date">, and the save route
// (app/api/meeting-notes/route.ts) only accepts an ISO "YYYY-MM-DD" value
// or something new Date() can parse. The system prompt (organize.ts),
// deliberately unchanged here, explicitly invites the model to express a
// relative timeframe as text (its own example: "after Yom Tov", "next
// week") rather than always a calendar date -- confirmed live, a real
// Workers AI response returned suggestedDueDate: "early next week" for
// exactly that kind of transcript. A bare "YYYY-MM-DD" check is enough to
// tell the two cases apart: the date picker can only ever display the
// former.
function isIsoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// AI-proposed follow-ups are suggestions, never a pre-checked default --
// the fundraiser must explicitly check Approve for each one before it can
// ever be saved (see selectApprovedFollowUps below). A non-calendar
// suggestedDueDate (a relative phrase the date picker can't represent)
// is folded into the description instead of silently discarded or passed
// through to a date field that would reject it at save time -- the
// fundraiser still sees what the AI understood and can pick an exact date
// themselves if they approve it.
export function followUpFromSuggestion(action: OrganizedFollowUp, id: string): FollowUpRow {
  const suggested = action.suggestedDueDate?.trim() ?? "";
  if (suggested.length === 0 || isIsoDateOnly(suggested)) {
    return { id, description: action.description, dueAt: suggested, approved: false };
  }
  return { id, description: `${action.description} (${suggested})`, dueAt: "", approved: false };
}

// A manually-added row gets the exact same treatment as an AI suggestion
// -- there is no "manual entry is pre-approved" shortcut.
export function emptyFollowUp(id: string): FollowUpRow {
  return { id, description: "", dueAt: "", approved: false };
}

// The only follow-ups that may ever reach the save request: explicitly
// approved AND with real description text (an approved-but-blank row,
// e.g. one the fundraiser checked and then emptied out, is dropped rather
// than saved as an empty task).
export function selectApprovedFollowUps(rows: FollowUpRow[]): Array<{ description: string; dueAt: string | null }> {
  return rows
    .filter((row) => row.approved && row.description.trim().length > 0)
    .map((row) => ({ description: row.description.trim(), dueAt: row.dueAt || null }));
}
