import { addCalendarDays, localDateParts, zonedTimeToUtc } from "../workspace/local-time.ts";

export type InteractionKind = "call" | "email" | "meeting" | "visit" | "note" | "personal";
export type ReminderChoice = "none" | "tomorrow" | "next-week" | "custom";

export type InteractionExtraction = {
  type: InteractionKind;
  subject: string;
  suggestedSubject: string;
  summary: string;
  memory: string;
  relationshipSummary: string;
  nextAction: string;
  commitments: string[];
};

const KIND_LABELS: Record<InteractionKind, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  visit: "Visit",
  note: "Note",
  personal: "Personal interaction",
};

export function interactionKindLabel(kind: InteractionKind): string {
  return KIND_LABELS[kind];
}

export function inferInteractionKind(note: string): InteractionKind {
  const lower = note.toLowerCase();
  if (/\b(called|phone|spoke by phone|voicemail)\b/.test(lower)) return "call";
  if (/\b(emailed|email|wrote to|replied)\b/.test(lower)) return "email";
  if (/\b(coffee|lunch|dinner|met|meeting)\b/.test(lower)) return "meeting";
  if (/\b(visit|visited|campus tour|stopped by)\b/.test(lower)) return "visit";
  if (/\b(birthday|anniversary|family|personal)\b/.test(lower)) return "personal";
  return "note";
}

export function inferSubject(note: string, kind: InteractionKind): string {
  const signals: Array<[RegExp, string]> = [
    [/\b(pledge|pledged|pledge balance|installment|payment)\b/i, "Pledge payment"],
    [/\b(gift|giving|donation|contribution)\b/i, "Giving follow-up"],
    [/\b(scholarship|student|tuition|education)\b/i, "Scholarship update"],
    [/\b(outcome|outcomes|impact|result|results|progress report|annual report)\b/i, "Impact update"],
    [/\b(campus|tour|school visit|site visit)\b/i, "Campus visit"],
    [/\b(proposal|request for support|funding request|ask amount)\b/i, "Proposal follow-up"],
    [/\b(event|gala|dinner|reception|parlor meeting)\b/i, "Event planning"],
    [/\b(family|spouse|son|daughter|birthday|anniversary)\b/i, "Personal update"],
  ];
  const matches = signals
    .map(([pattern, label]) => ({ label, index: note.search(pattern) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.label === item.label) === index)
    .slice(0, 2)
    .map((item) => item.label);
  if (matches.length === 2) return `${matches[0]} and ${matches[1].toLowerCase()}`;
  if (matches.length === 1) return matches[0];
  const fallbacks: Record<InteractionKind, string> = {
    call: "Donor call follow-up",
    email: "Donor email follow-up",
    meeting: "Donor meeting follow-up",
    visit: "Donor visit follow-up",
    note: "Relationship update",
    personal: "Personal update",
  };
  return fallbacks[kind];
}

const sentenceList = (note: string) => note.trim().split(/(?:[.!?]+\s+|[\r\n]+)/).map((item) => item.trim()).filter(Boolean);
const concise = (value: string, max = 180) => value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;

function mentionedPeople(note: string) {
  const ignored = new Set(["Called", "Emailed", "Meeting", "Coffee", "Lunch", "Dinner", "Visited", "Discussed", "Shared", "Send", "Follow", "The", "This", "She", "He", "They", "We", "I"]);
  const names = note.match(/\b\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu) ?? [];
  return [...new Set(names.map((name) => name.trim().replace(/[’']s$/u, "")).filter((name) => !ignored.has(name) && !/\b(?:Foundation|University|College|School|Yeshiva|Synagogue|Congregation|Hospital|Inc|LLC)\b/u.test(name)))].slice(0, 5);
}

function mentionedOrganizations(note: string) {
  const organizations = note.match(/\b(?:\p{Lu}[\p{L}'’&.-]*\s+){0,5}(?:Foundation|University|College|School|Yeshiva|Synagogue|Congregation|Hospital|Company|Inc\.?|LLC)\b/gu) ?? [];
  return [...new Set(organizations.map((item) => item.trim()))].slice(0, 5);
}

function commitmentAction(sentence: string) {
  const match = sentence.match(/\b(?:promised|agreed|committed|will|would)\s+(?:to\s+)?(.+)/i);
  if (match?.[1]) return concise(match[1].replace(/[.!?]+$/, ""), 120);
  const direct = sentence.match(/\b(send|follow up|call back|introduce|schedule|share|provide)\b(.+)/i);
  return direct ? concise(`${direct[1]}${direct[2]}`.replace(/[.!?]+$/, ""), 120) : null;
}

export type RelationshipSnapshotDetails = {
  topics: string[];
  people: string[];
  organizations: string[];
  commitments: string[];
  openFollowUps: string[];
  relationshipChanges: string[];
  recommendedNextAction: string;
};

export function relationshipSnapshotDetails(note: string, kind: InteractionKind): RelationshipSnapshotDetails {
  const sentences = sentenceList(note);
  const topics = inferSubject(note, kind).split(" and ").map((topic) => topic.replace(/^./, (letter) => letter.toUpperCase()));
  const people = mentionedPeople(note);
  const organizations = mentionedOrganizations(note);
  const commitmentSentences = sentences.filter((sentence) => /\b(promised|agreed|committed|will|would|send|follow up|follow-up|call back|introduce|schedule|share|provide)\b/i.test(sentence)).slice(0, 3);
  const relationshipChanges = sentences.filter((sentence) => /\b(increased|decreased|changed|newly|no longer|ready|hesitant|more involved|less involved|reconnected|stepped back)\b/i.test(sentence)).slice(0, 2);
  const nextAction = commitmentSentences.map(commitmentAction).find(Boolean) ?? "Review this note before the next interaction";
  return {
    topics,
    people,
    organizations,
    commitments: commitmentSentences.map((item) => concise(item).replace(/[.!?]+$/, "")),
    openFollowUps: commitmentSentences.length ? [nextAction] : [],
    relationshipChanges: relationshipChanges.map((item) => concise(item).replace(/[.!?]+$/, "")),
    recommendedNextAction: nextAction,
  };
}

export function actionableRelationshipSnapshot(note: string, kind: InteractionKind) {
  const details = relationshipSnapshotDetails(note, kind);
  const topicLabel = details.topics.map((topic, index) => index ? topic.toLowerCase() : topic).join(" and ");
  return [
    `Latest discussion topics: ${topicLabel}.`,
    details.people.length ? `People mentioned: ${details.people.join(", ")}.` : null,
    details.organizations.length ? `Organizations mentioned: ${details.organizations.join(", ")}.` : null,
    details.commitments.length ? `Commitments: ${details.commitments.join("; ")}.` : null,
    details.openFollowUps.length ? `Open follow-ups: ${details.openFollowUps.join("; ")}.` : null,
    details.relationshipChanges.length ? `Relationship changes: ${details.relationshipChanges.join("; ")}.` : null,
    `Recommended next action: ${details.recommendedNextAction}.`,
  ].filter(Boolean).join("\n");
}

export function sanitizeRelationshipSnapshot(value: string | null) {
  if (!value) return value;
  const cleaned = value
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .map((item) => item.trim())
    .filter((item) => item && !/\b(?:AI confidence|sentiment|classification|extraction status|positive or negative sentiment was inferred)\b/i.test(item))
    .join(" ");
  return cleaned || null;
}

export function splitInteractionSummary(summary: string) {
  const [subject = "", ...noteParts] = summary.split("\n");
  const note = noteParts.join("\n");
  const firstLine = note.split(/[\r\n]/, 1)[0]?.trim() ?? "";
  return { subject, note, timelineTitle: subject.trim() || "Interaction Note", timelineNote: (subject.trim() ? note.trim() : firstLine) || "No additional notes recorded." };
}

// "tomorrow"/"next-week" are relative to the user's own local calendar day
// (in `timezone`, not the Cloudflare Worker's UTC runtime clock), and
// every reminder lands at 9:00 AM local wall-clock time on its target day
// -- never 9:00 AM UTC. `timezone` defaults to "America/New_York" (this
// workspace's expected default, matching lib/auth/profile.ts) only when a
// caller genuinely has no stored profile timezone to pass; ordinary
// callers should always pass profile.timezone.
export function reminderDueAt(choice: ReminderChoice, customDate: string | undefined, now: Date, timezone = "America/New_York"): Date | null {
  if (choice === "none") return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (choice === "tomorrow") {
    const target = addCalendarDays(localDateParts(nowSeconds, timezone), 1);
    return zonedTimeToUtc(target.year, target.month, target.day, 9, 0, timezone);
  }
  if (choice === "next-week") {
    const target = addCalendarDays(localDateParts(nowSeconds, timezone), 7);
    return zonedTimeToUtc(target.year, target.month, target.day, 9, 0, timezone);
  }
  if (choice === "custom") {
    if (!customDate || !/^\d{4}-\d{2}-\d{2}$/.test(customDate)) return null;
    const [year, month, day] = customDate.split("-").map(Number);
    return zonedTimeToUtc(year, month, day, 9, 0, timezone);
  }
  return null;
}

export function extractInteraction(note: string, requestedKind?: InteractionKind, requestedSubject?: string): InteractionExtraction {
  const type = requestedKind ?? inferInteractionKind(note);
  const subject = requestedSubject?.trim() ?? "";
  const suggestedSubject = inferSubject(note, type);
  const lower = note.toLowerCase();
  const actionContext = subject || suggestedSubject;
  const commitments = [
    ...(lower.includes("send") ? [`Send the material referenced in “${actionContext}”`] : []),
    ...(/follow up|follow-up/.test(lower) ? [`Follow up on “${actionContext}”`] : []),
  ];
  return {
    type,
    subject,
    suggestedSubject,
    summary: note.trim(),
    memory: `${interactionKindLabel(type)} context: ${note.trim()}`,
    relationshipSummary: actionableRelationshipSnapshot(note, type),
    nextAction: commitments[0] ?? `Review the ${interactionKindLabel(type).toLowerCase()} note before the next interaction.`,
    commitments,
  };
}
