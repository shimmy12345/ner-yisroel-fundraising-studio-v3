import type { AIRequest, AIResult, AIService, AssistantContextSnapshot, AssistantTask } from "./types";

export function classifyAssistantPrompt(prompt: string): AssistantTask {
  const value = prompt.toLowerCase();
  if (/thank|acknowledge|gratitude/.test(value)) return "draft";
  if (/meeting|prepare|talking point/.test(value)) return "meeting-brief";
  if (/haven.t|recent|lapsed|re-?engage|spoken/.test(value)) return "lapsed-relationships";
  if (/president|executive|month|report/.test(value)) return "executive-summary";
  if (/relationship|donor|history|summary/.test(value)) return "relationship-summary";
  return "next-action";
}
const sources = (snapshot: AssistantContextSnapshot) => [...new Set([...(snapshot.latestInteraction ? [snapshot.latestInteraction.id] : []), ...snapshot.recommendations.map((item) => item.id), ...snapshot.gifts.map((item) => item.id)])];
const result = (title: string, content: string, rationale: string[], sourceIds: string[]): AIResult => ({ mode: "rule-based", title, content, rationale, confidence: 1, sourceIds });
// Always appended as its own clearly-labeled block, never blended into the
// summary/memory text above it -- each line already states its own
// uncertainty (lib/relationships/historical-context.ts), and
// donor_historical_context.status is always 'unconfirmed' by construction.
const unconfirmedBlock = (snapshot: AssistantContextSnapshot) => snapshot.donor.unconfirmedHistoricalContext.length
  ? `Imported context (not verified, not counted as contact):\n${snapshot.donor.unconfirmedHistoricalContext.map((line) => `- ${line}`).join("\n")}`
  : null;
// Family background (Yahrtzeit, Birthday, Anniversary), never an
// interaction and never implying outreach occurred -- always shown when
// present, independent of whether one of the relationship-date outreach
// candidates happens to be the winning suggested action right now.
const familyContextBlock = (snapshot: AssistantContextSnapshot) => snapshot.donor.familyImportantDates.length
  ? `Family context: ${snapshot.donor.familyImportantDates.join(" ")}`
  : null;
// Confirmed, structured evidence (a real asks row) -- never called an
// "opportunity," never blended into summary/memory. Empty when the donor
// has no open (pending) ask.
const openAsksBlock = (snapshot: AssistantContextSnapshot) => snapshot.donor.openAsks.length
  ? snapshot.donor.openAsks.join(" ")
  : null;

export class RuleBasedAIService implements AIService {
  async complete(request: AIRequest): Promise<AIResult> {
    const s = request.context.snapshot;
    if (request.task === "meeting-brief") {
      const meeting = s.meetings[0];
      if (!meeting) return result("No upcoming donor meeting", "No upcoming donor meeting is recorded in your live workspace. Add a dated meeting reminder to make preparation available here.", ["Checked upcoming live reminders"], sources(s));
      // Suggested action comes straight from the shared recommendation
      // engine (lib/relationships/recommendation-rank.ts) via
      // s.donor.recommendation -- never re-derived from s.recommendations
      // here, so this can never disagree with the actual Meeting Brief
      // page or donor profile for the same donor.
      return result(`Meeting preparation: ${meeting.title}`, [`${meeting.time} ${meeting.period} · ${meeting.detail}`, `Relationship context: ${s.donor.summary}`, `Institutional memory: ${s.donor.memory}`, s.latestInteraction ? `Latest interaction: ${s.latestInteraction.summary}` : "No prior interaction is recorded.", s.donor.recommendation ? `Suggested action: ${s.donor.recommendation.action} ${s.donor.recommendation.why}` : "No suggested action is available.", openAsksBlock(s), familyContextBlock(s), unconfirmedBlock(s)].filter((line): line is string => line !== null).join("\n\n"), ["Upcoming reminder", "Owner-scoped relationship record", "Latest interaction"], sources(s));
    }
    if (request.task === "draft") {
      const gift = s.gifts[0];
      if (!gift) return result("No recent gift to acknowledge", "No recent gift is available in your live workspace. Import giving history or choose a specific donor after a gift is recorded.", ["Checked live gifts from the last 30 days"], sources(s));
      return result(`Thank-you draft for ${gift.name}`, `Subject: Thank you for your generous support\n\nDear ${gift.name},\n\nThank you for your ${gift.amount} gift. Your support means a great deal to our organization, and I’m grateful for your partnership.\n\nI would welcome the chance to share more about the impact of your generosity.\n\nWith appreciation,`, ["Used the most recent live gift", "Added no unsupported personal details"], sources(s));
    }
    if (request.task === "lapsed-relationships") {
      const items = s.priorities.filter((item) => /contact|lapsed|days since/i.test(`${item.label} ${item.reason}`));
      return result("Relationships needing contact", items.length ? items.map((item, i) => `${i + 1}. ${item.name} — ${item.reason}. ${item.why}`).join("\n") : "No lapsed relationship appears in the current live priorities.", ["Filtered owner-scoped priorities for contact gaps"], sources(s));
    }
    if (request.task === "executive-summary") return result("Executive fundraising summary", `${s.priorities.length} current priorities, ${s.meetings.length} upcoming meetings, ${s.gifts.length} recent gifts, and ${s.recommendations.length} open next actions are visible in the live workspace.${s.priorities[0] ? ` The first recommended focus is ${s.priorities[0].name}: ${s.priorities[0].reason}.` : " No immediate action is currently ranked."}`, ["Live priorities, reminders, meetings, and gifts"], sources(s));
    if (request.task === "relationship-summary") return result(`Relationship summary: ${s.donor.name}`, [`${s.donor.summary}\n\nInstitutional memory: ${s.donor.memory}\n\n${s.latestInteraction ? `Latest interaction: ${s.latestInteraction.summary}` : "No interaction is recorded."}`, openAsksBlock(s), unconfirmedBlock(s)].filter((line): line is string => line !== null).join("\n\n"), ["Owner-scoped donor and interaction records"], sources(s));
    return result("Recommended next actions", s.priorities.length ? s.priorities.slice(0, 3).map((item, i) => `${i + 1}. ${item.action} for ${item.name} — ${item.reason}. ${item.why}`).join("\n") : "No next action can be recommended from the current live workspace.", ["Ranked live reminders, pledges, gifts, and contact gaps"], sources(s));
  }
}
