import type { AIRequest, AIResult, AIService, AssistantContextSnapshot, AssistantTask } from "./types";

export function classifyAssistantPrompt(prompt: string): AssistantTask {
  const value = prompt.toLowerCase();
  if (/thank|marcus|acknowledge/.test(value)) return "draft";
  if (/meeting|prepare|chen|talking point/.test(value)) return "meeting-brief";
  if (/haven.t|recent|lapsed|re-?engage|spoken/.test(value)) return "lapsed-relationships";
  if (/president|executive|month|report|summary/.test(value)) return "executive-summary";
  if (/relationship|donor|elena|history/.test(value)) return "relationship-summary";
  return "next-action";
}

function sourceIds(snapshot: AssistantContextSnapshot, extras: string[] = []) {
  return [
    ...snapshot.latestInteraction ? [snapshot.latestInteraction.id] : [],
    ...snapshot.recommendations.map((item) => item.id),
    ...snapshot.gifts.map((gift) => gift.id),
    ...extras,
  ];
}

function result(
  title: string,
  content: string,
  rationale: string[],
  sources: string[],
): AIResult {
  return {
    mode: "rule-based",
    title,
    content,
    rationale,
    confidence: 1,
    sourceIds: [...new Set(sources)],
  };
}

export class RuleBasedAIService implements AIService {
  async complete(request: AIRequest): Promise<AIResult> {
    const { snapshot } = request.context;

    if (request.task === "meeting-brief") {
      const meeting = snapshot.meetings.find((item) => /chen/i.test(item.title));
      const nextAction = snapshot.recommendations[0]?.action ?? snapshot.priorities[0]?.action;
      return result(
        "Meeting preparation: Elena & David Chen",
        [
          `${meeting ? `${meeting.time} ${meeting.period} · ${meeting.detail}` : "Today’s Chen meeting"}`,
          `Relationship context: ${snapshot.donor.summary}`,
          `Institutional memory: ${snapshot.donor.memory}`,
          snapshot.latestInteraction ? `Latest interaction: ${snapshot.latestInteraction.summary}` : "No recent interaction is available in staging.",
          `Recommended approach: Lead with Maya Rodriguez’s progress, give David the outcomes he requested, and ask how the Chens want to stay connected before discussing another gift.`,
          `Next action on record: ${nextAction ?? "Confirm the follow-up owner and date after the meeting."}`,
        ].join("\n\n"),
        ["Current relationship summary", "Latest interaction and institutional memory", "Today’s scheduled meeting"],
        sourceIds(snapshot, ["today:meeting:chen"]),
      );
    }

    if (request.task === "draft") {
      const gift = snapshot.gifts.find((item) => /marcus/i.test(item.name));
      const amount = gift?.amount ?? "recent";
      const detail = gift?.detail ?? "gift shown in today’s queue";
      return result(
        "Draft thank-you for Marcus Williams",
        [
          "Subject: Thank you for your generous support",
          "Dear Marcus,",
          `Thank you for your ${amount} gift. Your ${detail.toLowerCase()} strengthens the work our community makes possible, and I’m grateful that you chose to support it.`,
          "I would welcome the chance to share what your generosity is helping advance and to thank you personally.",
          "With appreciation,\nSarah",
          "Context note: Staging currently has gift details for Marcus but no full relationship record, so review the tone before sending.",
        ].join("\n\n"),
        ["Gift amount and fund shown in today’s queue", "No unsupported personal details added"],
        sourceIds(snapshot, [gift?.id ?? "today:gift:marcus"]),
      );
    }

    if (request.task === "lapsed-relationships") {
      const candidates = snapshot.priorities.filter((item) =>
        /re-engage|follow up/i.test(item.label) || /no contact|follow-up/i.test(item.reason),
      );
      const content = candidates.length
        ? candidates.map((item, index) => `${index + 1}. ${item.name} — ${item.reason}. ${item.why} Next step: ${item.action}.`).join("\n")
        : "No re-engagement candidates are present in the current staging priorities.";
      return result(
        "Relationships needing follow-up",
        content,
        ["Filtered current priorities for elapsed contact and open follow-up signals"],
        sourceIds(snapshot, ["today:priorities"]),
      );
    }

    if (request.task === "executive-summary") {
      return result(
        "Executive fundraising summary",
        [
          `${snapshot.priorities.length} active priorities are in view. The strongest immediate opportunity is ${snapshot.priorities[0]?.name ?? snapshot.donor.name}.`,
          `${snapshot.meetings.length} meetings are scheduled today, including ${snapshot.meetings.map((item) => item.title).join(", ")}.`,
          `${snapshot.gifts.length} current gift items are available: ${snapshot.gifts.map((gift) => `${gift.name} (${gift.amount})`).join(", ")}.`,
          `Relationship momentum: ${snapshot.donor.summary}`,
          `Recommended leadership attention: protect the Chen meeting preparation window and complete time-sensitive stewardship for Marcus Williams.`,
        ].join("\n\n"),
        ["Today’s ranked priorities", "Current meetings and gifts", "Staging relationship record"],
        sourceIds(snapshot, ["today:priorities", "today:meetings"]),
      );
    }

    if (request.task === "relationship-summary") {
      return result(
        `Relationship summary: ${snapshot.donor.name}`,
        [
          snapshot.donor.summary,
          `Institutional memory: ${snapshot.donor.memory}`,
          snapshot.latestInteraction ? `Latest interaction: ${snapshot.latestInteraction.summary}` : "No recent interaction is available in staging.",
          snapshot.recommendations[0] ? `Open next action: ${snapshot.recommendations[0].action}. ${snapshot.recommendations[0].reason}` : "No open recommendation is available.",
        ].join("\n\n"),
        ["Current donor record", "Latest interaction", "Open recommendation"],
        sourceIds(snapshot),
      );
    }

    const ranked = snapshot.priorities.slice(0, 3);
    return result(
      "Recommended next actions",
      ranked.map((item, index) => `${index + 1}. ${item.action} for ${item.name} — ${item.reason}. ${item.why}`).join("\n"),
      ["Ranked from current timing, momentum, and follow-up signals"],
      sourceIds(snapshot, ["today:priorities"]),
    );
  }
}
