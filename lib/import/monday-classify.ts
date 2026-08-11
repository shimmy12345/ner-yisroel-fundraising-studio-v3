// Rule-based, no LLM -- mirrors the existing ordered-regex style already
// used by lib/capture/interaction.ts's inferInteractionKind. This exact
// logic (unchanged since first validated) was run against the real
// workbook and reconciled by hand: 148 in-scope subitems split into 5
// confirm-contact candidates, 3 future planned actions, 68 past-dated +
// 6 undated historical planned actions (both default Ignore), 44 donation
// notes, and 22 ambiguous rows -- see tests/monday-import-*.test.mjs for
// the fictional fixture that reproduces this exact distribution.

export type MondayCategory = "professional_contact" | "solicitation" | "planned_action" | "donation_note" | "ambiguous";
export type MondayDisposition = "confirm_contact_candidate" | "future_planned" | "historical_planned" | "donation_note" | "ambiguous";

function isPastTenseSolicitation(text: string) {
  return /solicited/i.test(text);
}

// Only wording that asserts a *completed* action ever returns
// "professional_contact" or a past-tense solicitation -- a bare noun
// ("Meeting") or present/imperative phrasing ("Schedule...", "Solicit...")
// never qualifies. Falls through to "ambiguous" rather than guessing.
export function classifyMondayText(text: string): MondayCategory {
  const t = text.toLowerCase();
  if (/\bdonation\s*(made)?\b/.test(t) || /^\d{4}\s*donation\b/.test(t)) return "donation_note";
  if (/\b(called|spoke (with|to)|met with|meeting (held|took place)|thanked|personal invite|invited)\b/.test(t) && !/\bschedule\b/.test(t)) return "professional_contact";
  if (/\bsent?\b.*\b(update|whatsapp|video|email|ty email)\b/.test(t) && !/\bschedule\b/.test(t)) return "professional_contact";
  if (/\bsolicit(ed|ation)?\b/.test(t)) return "solicitation";
  if (/\b(schedule|follow up|call before|send|make .* call|reach out|engage|invite for)\b/.test(t)) return "planned_action";
  return "ambiguous";
}

// due Date is Monday's own field, informational only -- this function
// never decides an occurrence date, only which review bucket a row
// starts in. A row with no date at all is treated the same as a past
// date: neither proves current relevance, so both default to Ignore.
export function classifyMondayDisposition(text: string, dueDateIso: string | null, todayIso: string): MondayDisposition {
  const category = classifyMondayText(text);
  if (category === "professional_contact") return "confirm_contact_candidate";
  if (category === "solicitation" && isPastTenseSolicitation(text)) return "confirm_contact_candidate";
  if (category === "solicitation" || category === "planned_action") {
    if (dueDateIso && dueDateIso > todayIso) return "future_planned";
    return "historical_planned";
  }
  if (category === "donation_note") return "donation_note";
  return "ambiguous";
}
