// Follow-up approval rules shared by MeetingNotesExperience.tsx
// (docs/AI-HANDOFF.md, "Meeting Notes Final Safeguards and AI
// Readiness"). Pure and UI-free so the "every follow-up starts
// unapproved, and only approved ones with real text are ever sent to
// save" rule is independently testable, not just eyeballed in the
// component.

import type { OrganizedFollowUp } from "./organize";

export type FollowUpRow = { id: string; description: string; dueAt: string; approved: boolean };

// AI-proposed follow-ups are suggestions, never a pre-checked default --
// the fundraiser must explicitly check Approve for each one before it can
// ever be saved (see selectApprovedFollowUps below).
export function followUpFromSuggestion(action: OrganizedFollowUp, id: string): FollowUpRow {
  return { id, description: action.description, dueAt: action.suggestedDueDate ?? "", approved: false };
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
