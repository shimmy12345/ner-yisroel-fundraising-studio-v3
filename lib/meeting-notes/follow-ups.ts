// Follow-up approval rules shared by MeetingNotesExperience.tsx
// (docs/AI-HANDOFF.md, "Meeting Notes Final Safeguards and AI
// Readiness" / "Fix AI Follow-Up Scheduling and Prepare Owner
// Testing"). Pure and UI-free so the "every follow-up starts
// unapproved, only approved ones with real text are ever sent to save,
// and nothing is silently saved undated" rules are independently
// testable, not just eyeballed in the component.

import type { OrganizedFollowUp } from "./organize";
import { resolveDueDatePhrase } from "./due-date-resolver.ts";

// dueDateSource distinguishes HOW dueAt got its value, so the review
// screen can clearly label an AI-computed date differently from one the
// fundraiser typed themselves (the task's own "clearly distinguish an
// AI-suggested date from a date explicitly stated" requirement):
//   - "explicit"   -- the transcript stated an actual calendar date
//   - "ai-resolved" -- a relative phrase ("tomorrow", "next Monday") this
//                      app's own date arithmetic computed
//   - "manual"     -- the fundraiser set or edited this date themselves
//   - "unset"      -- no date yet (AI gave none, or suggested a phrase
//                      that could not be reliably resolved)
export type DueDateSource = "explicit" | "ai-resolved" | "manual" | "unset";

export type FollowUpRow = {
  id: string;
  description: string;
  dueAt: string;
  approved: boolean;
  dueDateSource: DueDateSource;
  // The AI's own original wording for the due date, if it said anything
  // at all -- kept for display regardless of whether dueAt could be
  // resolved from it, so the fundraiser can always see what was actually
  // said (never silently discarded).
  aiPhrase: string | null;
  // The fundraiser's explicit confirmation that this follow-up is
  // intentionally left without a due date -- required before an approved,
  // undated row may be saved (see validateFollowUpsForSave below).
  confirmedUnscheduled: boolean;
};

// AI-proposed follow-ups are suggestions, never a pre-checked default --
// the fundraiser must explicitly check Approve for each one before it can
// ever be saved (see selectApprovedFollowUps below). meetingDateISO
// anchors relative-date resolution ("tomorrow" means the day after the
// MEETING, not after whenever the note happens to be typed).
export function followUpFromSuggestion(action: OrganizedFollowUp, id: string, meetingDateISO: string): FollowUpRow {
  const resolution = resolveDueDatePhrase(action.suggestedDueDate, meetingDateISO);
  const base = { id, description: action.description, approved: false, confirmedUnscheduled: false };

  switch (resolution.kind) {
    case "none":
      return { ...base, dueAt: "", dueDateSource: "unset", aiPhrase: null };
    case "explicit":
      return { ...base, dueAt: resolution.date, dueDateSource: "explicit", aiPhrase: resolution.phrase };
    case "resolved":
      return { ...base, dueAt: resolution.date, dueDateSource: "ai-resolved", aiPhrase: resolution.phrase };
    case "unresolved":
      // Never invent a precise date for ambiguous or Hebrew-calendar
      // wording -- the date field stays empty, but the original phrase
      // is preserved (via aiPhrase) for the fundraiser to see and act on.
      return { ...base, dueAt: "", dueDateSource: "unset", aiPhrase: resolution.phrase };
    default:
      return resolution satisfies never;
  }
}

// A manually-added row gets the exact same treatment as an AI suggestion
// -- there is no "manual entry is pre-approved" shortcut.
export function emptyFollowUp(id: string): FollowUpRow {
  return { id, description: "", dueAt: "", approved: false, dueDateSource: "unset", aiPhrase: null, confirmedUnscheduled: false };
}

// The only follow-ups that may ever reach the save request: explicitly
// approved AND with real description text (an approved-but-blank row,
// e.g. one the fundraiser checked and then emptied out, is dropped rather
// than saved as an empty task). Only description/dueAt are sent -- the
// save route has never needed to know dueDateSource/aiPhrase/
// confirmedUnscheduled, which exist purely to drive the review screen.
export function selectApprovedFollowUps(rows: FollowUpRow[]): Array<{ description: string; dueAt: string | null }> {
  return rows
    .filter((row) => row.approved && row.description.trim().length > 0)
    .map((row) => ({ description: row.description.trim(), dueAt: row.dueAt || null }));
}

// The pre-save gate the task asks for: "if an approved follow-up has no
// valid due date, require the fundraiser to choose one or explicitly
// confirm that the task is intentionally unscheduled. Do not silently
// save an undated follow-up that was intended to be scheduled." Checked
// client-side before the save request is ever built -- a row that fails
// this blocks Save entirely, the same way an empty idempotency key or a
// too-long transcript already blocks other actions elsewhere in this
// feature. Returns the ids of every approved, undated, unconfirmed row
// so the UI can point the fundraiser at exactly which ones need
// attention.
export function findUnresolvedApprovedFollowUps(rows: FollowUpRow[]): string[] {
  return rows
    .filter((row) => row.approved && row.description.trim().length > 0)
    .filter((row) => row.dueAt.trim().length === 0 && !row.confirmedUnscheduled)
    .map((row) => row.id);
}
