import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RuleBasedAIService, classifyAssistantPrompt } from "../lib/ai/rule-based.ts";

const snapshot = {
  donor: {
    id: "elena-chen",
    name: "Elena & David Chen",
    summary: "Longstanding scholarship partners with rising engagement.",
    memory: "Elena connects through student stories; David asks for outcomes.",
  },
  latestInteraction: {
    id: "interaction-1",
    summary: "Requested scholarship outcomes before discussing a fall visit.",
    occurredAt: "2026-07-30T14:00:00.000Z",
  },
  recommendations: [{ id: "recommendation-1", action: "Send scholarship outcomes", reason: "Open commitment", dueAt: "2026-08-01T13:00:00.000Z" }],
  priorities: [
    { name: "Elena & David Chen", label: "High momentum", reason: "Meeting today at 2:00 PM", why: "Recent engagement", action: "Prepare" },
    { name: "Priya & Arun Mehta", label: "Re-engage", reason: "No contact in 94 days", why: "Program begins next week", action: "Reach out" },
  ],
  meetings: [{ time: "2:00", period: "PM", title: "Elena & David Chen", detail: "The Garden Room · 45 min" }],
  gifts: [{ id: "gift-marcus", name: "Marcus Williams", amount: "$10,000", detail: "Annual Fund · 2h ago" }],
};

async function request(task, prompt = "") {
  return new RuleBasedAIService().complete({
    task,
    prompt,
    context: { userId: "staging-user", donorId: "elena-chen", interactionIds: ["interaction-1"], snapshot },
  });
}

async function run() {
  const page = await readFile(new URL("../app/assistant/page.tsx", import.meta.url), "utf8");
  const assistant = await readFile(new URL("../app/assistant/AssistantExperience.tsx", import.meta.url), "utf8");
  const brief = await readFile(new URL("../app/components/BriefExperience.tsx", import.meta.url), "utf8");
  const speech = await readFile(new URL("../app/components/useBriefSpeech.ts", import.meta.url), "utf8");
  const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /<AssistantExperience brief=\{brief\} timezone=\{profile\.timezone\} \/>/);
  assert.match(today, /<BriefExperience surface="today" data=\{data\} timezone=\{profile\.timezone\} \/>/);
  assert.match(assistant, /<BriefExperience surface="assistant" data=\{brief\} timezone=\{timezone\} \/>/);
  assert.match(brief, /Read full brief/);
  assert.match(brief, /Collapse full brief/);
  assert.match(brief, /aria-expanded=\{isExpanded\}/);
  assert.match(brief, /Top priorities/);
  assert.match(brief, /Today’s schedule/);
  assert.match(brief, /Upcoming activities/);
  assert.match(brief, /Recent gifts/);
  assert.match(brief, /Recommended focus/);

  assert.match(speech, /speechSynthesis\.speak/);
  assert.match(speech, /speechSynthesis\.pause/);
  assert.match(speech, /speechSynthesis\.resume/);
  assert.match(speech, /speechSynthesis\.cancel/);
  assert.match(speech, /return \(\) =>/);
  assert.match(speech, /Listening is not supported in this browser/);

  assert.match(assistant, /if \(inFlightRef\.current\) return/);
  assert.match(assistant, /inFlightRef\.current = true/);
  assert.match(assistant, /disabled=\{loading\}/);
  assert.match(assistant, /state === "loading"/);
  assert.match(assistant, /state === "success"/);
  assert.match(assistant, /state === "empty"/);
  assert.match(assistant, /state === "error"/);
  assert.match(assistant, /event\.metaKey \|\| event\.ctrlKey/);
  assert.doesNotMatch(assistant, /setPrompt\(""\)/);
  assert.doesNotMatch(assistant, /Coming soon/);

  assert.equal(classifyAssistantPrompt("Prepare me for the Chen meeting"), "meeting-brief");
  assert.equal(classifyAssistantPrompt("Draft a thank-you for Marcus"), "draft");
  assert.equal(classifyAssistantPrompt("Who has not been spoken with recently?"), "lapsed-relationships");
  assert.equal(classifyAssistantPrompt("Summarize the month for the president"), "executive-summary");

  const meeting = await request("meeting-brief");
  assert.equal(meeting.mode, "rule-based");
  assert.match(meeting.content, /Garden Room/i);
  assert.match(meeting.content, /Next action/i);
  const thankYou = await request("draft");
  assert.match(thankYou.content, /\$10,000/);
  assert.match(thankYou.content, /Dear Marcus/);
  const lapsed = await request("lapsed-relationships");
  assert.match(lapsed.content, /94 days/);
  const executive = await request("executive-summary");
  assert.match(executive.content, /current priorities/);

  process.stdout.write("Assistant and shared brief checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
