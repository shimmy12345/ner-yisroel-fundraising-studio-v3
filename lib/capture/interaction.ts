export type InteractionKind = "call" | "email" | "meeting" | "visit" | "note" | "personal";
export type ReminderChoice = "none" | "tomorrow" | "next-week" | "custom";

export type InteractionExtraction = {
  type: InteractionKind;
  subject: string;
  summary: string;
  sentiment: "warm" | "neutral";
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
  const lower = note.toLowerCase();
  const firstSentence = note.trim().split(/[.!?]\s|[\r\n]/, 1)[0]?.trim();
  if (firstSentence) {
    const concise = firstSentence.replace(/^(called|emailed|met with|coffee with|visited)\s+/i, "");
    return concise.length > 72 ? `${concise.slice(0, 69).trim()}…` : concise;
  }
  return `${interactionKindLabel(kind)} with donor`;
}

export function reminderDueAt(
  choice: ReminderChoice,
  customDate: string | undefined,
  now: Date,
): Date | null {
  if (choice === "none") return null;
  const due = new Date(now);
  due.setHours(9, 0, 0, 0);
  if (choice === "tomorrow") due.setDate(due.getDate() + 1);
  if (choice === "next-week") due.setDate(due.getDate() + 7);
  if (choice === "custom") {
    if (!customDate || !/^\d{4}-\d{2}-\d{2}$/.test(customDate)) return null;
    const [year, month, day] = customDate.split("-").map(Number);
    due.setFullYear(year, month - 1, day);
  }
  return due;
}

export function extractInteraction(
  note: string,
  requestedKind?: InteractionKind,
  requestedSubject?: string,
): InteractionExtraction {
  const type = requestedKind ?? inferInteractionKind(note);
  const subject = requestedSubject?.trim() || inferSubject(note, type);
  const lower = note.toLowerCase();
  const commitments = [
    ...(lower.includes("send") ? [`Send the material referenced in “${subject}”`] : []),
    ...(/follow up|follow-up/.test(lower) ? [`Follow up on “${subject}”`] : []),
  ];
  const warm = /loved|excited|interested|warm|glad|grateful|enthusiastic/.test(lower);
  return {
    type,
    subject,
    summary: note.trim(),
    sentiment: warm ? "warm" : "neutral",
    memory: `Captured from ${interactionKindLabel(type).toLowerCase()}: ${note.trim()}`,
    relationshipSummary: `Latest ${interactionKindLabel(type).toLowerCase()}: ${subject}. ${warm ? "The interaction showed positive engagement." : "No positive or negative sentiment was inferred."}`,
    nextAction: commitments[0] ?? `Follow up on ${subject.toLowerCase()}.`,
    commitments,
  };
}
