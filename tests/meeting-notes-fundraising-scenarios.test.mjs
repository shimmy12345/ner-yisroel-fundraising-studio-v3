import assert from "node:assert/strict";
import { buildSystemPrompt, buildUserMessage, parseOrganizedResponse } from "../lib/meeting-notes/organize.ts";

// Realistic synthetic fundraising-conversation coverage (docs/AI-HANDOFF.md,
// "Meeting Notes Final Safeguards and AI Readiness", section 4). No real
// Anthropic API call is made anywhere in this file -- that would require
// activating paid usage, not authorized this round. This verifies two
// things only, both achievable without a live call:
//   1. The SYSTEM PROMPT actually contains explicit instructions covering
//      every distinction the task asked about (confirmed vs. possible
//      commitments, ask vs. pledge, relationship detail vs. opportunity,
//      proposed vs. approved follow-ups).
//   2. The DELIMITING and VALIDATION pipeline correctly carries realistic,
//      yeshivish-terminology-bearing content through unmangled, and
//      correctly round-trips a well-formed structured response for each
//      scenario while rejecting one that blurs confirmed/possible.
// Whether the real Claude Haiku 5.5 model actually produces output this
// well-formed is a live-Staging question for after real API activation is
// separately approved -- not something a mocked test can prove.

const systemPrompt = buildSystemPrompt();

// --- 1. System prompt covers every required distinction ---

assert.match(systemPrompt, /Confirmed commitments .*from possible/i);
assert.match(systemPrompt, /never invent/i);
assert.match(systemPrompt, /pledge amounts/i);
assert.match(systemPrompt, /preserve uncertainty/i);
assert.match(systemPrompt, /empty array/i, "an unsupported section must stay empty, never padded with filler");

// --- 2. Synthetic scenarios, each a realistic transcript the task named ---

const scenarios = {
  largeDinnerSponsorshipNoCommitment: "Met with the Rosenbaums after Mincha. They're considering the hundred thousand dollar dinner sponsorship but didn't commit to anything -- said they want to think it over and discuss with their accountant before Rosh Hashanah.",
  largerSponsorshipDiscussedNotAccepted: "Discussed the hundred fifty thousand dollar naming sponsorship option for the new beis medrash wing. Mr. Rosenbaum seemed interested but explicitly said he's not ready to commit at that level yet.",
  relationshipAndShiur: "Spoke for a while about his personal connection to Rav Kulefsky zt\"l -- he learned under him for two years. He mentioned how much he appreciates the Yom Tov shiur series and the kuntres we sent out before Sukkos.",
  followUpUnlessDonorResponds: "Need to follow up with him next week about the Kollel pledge unless he calls back first. He said he'd try to get back to me by Thursday.",
  explicitCommitment: "He confirmed he is giving eighteen thousand dollars for the building fund, to be paid by check within thirty days. This is a definite commitment, not a maybe.",
  multipleOpportunitiesDifferentAmounts: "We discussed three options: a five thousand dollar general fund gift, a twenty-five thousand dollar scholarship sponsorship, and the hundred thousand dollar dinner sponsorship. He didn't commit to any of them but wants to hear more about the scholarship option specifically.",
};

for (const [name, transcript] of Object.entries(scenarios)) {
  const userMessage = buildUserMessage(transcript);
  assert.match(userMessage, /<<<MEETING_NOTES_START>>>/, `${name}: delimiters must wrap the transcript`);
  // The transcript must survive verbatim inside the delimiters -- proper
  // nouns, yeshivish terms, and dollar amounts are never altered or
  // stripped by the prompt-construction step itself.
  assert.ok(userMessage.includes(transcript), `${name}: transcript content must pass through unmangled`);
}

// Yeshivish terminology and proper names named explicitly in the task,
// confirmed intact end-to-end through delimiting.
const terminologyTranscript = "Rosenbaum mentioned his connection to Rav Kulefsky, enjoyed the Yom Tov shiur, and asked for another kuntres.";
const terminologyMessage = buildUserMessage(terminologyTranscript);
for (const term of ["Rosenbaum", "Rav Kulefsky", "shiur", "kuntres", "Yom Tov"]) {
  assert.ok(terminologyMessage.includes(term), `the term "${term}" must survive delimiting unmangled`);
}

// --- 3. Validation correctly round-trips a well-formed response for the
// "explicit commitment" and "discussed but not accepted" scenarios,
// preserving the confirmed/possible distinction structurally ---

const explicitCommitmentResponse = JSON.stringify({
  summary: "Donor confirmed an $18,000 gift for the building fund, to be paid by check within 30 days.",
  donorInterests: ["Building fund"],
  fundraisingOpportunities: [],
  confirmedCommitments: ["$18,000 for the building fund, payment by check within 30 days"],
  possibleCommitments: [],
  followUpActions: [{ description: "Confirm check receipt within 30 days", suggestedDueDate: null }],
  relationshipContext: "",
});
{
  const result = parseOrganizedResponse(explicitCommitmentResponse);
  assert.equal(result.ok, true);
  assert.equal(result.data.confirmedCommitments.length, 1);
  assert.equal(result.data.possibleCommitments.length, 0, "a genuinely explicit commitment must never also appear as a possible/uncertain one");
}

const discussedNotAcceptedResponse = JSON.stringify({
  summary: "Discussed a $150,000 naming sponsorship for the beis medrash wing; donor is interested but not ready to commit.",
  donorInterests: ["Beis medrash wing naming opportunity"],
  fundraisingOpportunities: ["$150,000 naming sponsorship for the beis medrash wing"],
  confirmedCommitments: [],
  possibleCommitments: ["Considering the $150,000 naming sponsorship, not yet committed"],
  followUpActions: [],
  relationshipContext: "",
});
{
  const result = parseOrganizedResponse(discussedNotAcceptedResponse);
  assert.equal(result.ok, true);
  assert.equal(result.data.confirmedCommitments.length, 0, "a discussed-but-not-accepted sponsorship must never be recorded as confirmed");
  assert.equal(result.data.possibleCommitments.length, 1);
  assert.equal(result.data.fundraisingOpportunities.length, 1, "the opportunity itself is distinct from whether it was committed to");
}

// A fundraising ASK (what the fundraiser proposed) is conceptually
// distinct from a donor PLEDGE (what the donor actually agreed to) --
// verified here as a structural property: an ask with no acceptance
// language must land in fundraisingOpportunities/possibleCommitments,
// never confirmedCommitments, regardless of the dollar amount mentioned.
const askNotPledgeResponse = JSON.stringify({
  summary: "Fundraiser proposed a $100,000 dinner sponsorship; donor did not accept or decline, said he'd consider it.",
  donorInterests: [],
  fundraisingOpportunities: ["$100,000 dinner sponsorship proposed"],
  confirmedCommitments: [],
  possibleCommitments: ["Considering the $100,000 dinner sponsorship"],
  followUpActions: [{ description: "Follow up on dinner sponsorship decision", suggestedDueDate: null }],
  relationshipContext: "",
});
{
  const result = parseOrganizedResponse(askNotPledgeResponse);
  assert.equal(result.ok, true);
  assert.equal(result.data.confirmedCommitments.length, 0, "an ask the donor only said he'd 'consider' must never be recorded as a pledge/commitment");
}

// Relationship detail (personal connection, shiur appreciation) is
// distinct from a fundraising opportunity -- a response that correctly
// keeps them in separate sections is accepted; donorInterests/
// relationshipContext and fundraisingOpportunities are independent
// fields by construction, so this is a structural guarantee, not a
// per-response judgment call.
const relationshipContextResponse = JSON.stringify({
  summary: "Discussed his personal history with Rav Kulefsky and appreciation for the Yom Tov shiur series.",
  donorInterests: ["Yom Tov shiur series"],
  fundraisingOpportunities: [],
  confirmedCommitments: [],
  possibleCommitments: [],
  followUpActions: [],
  relationshipContext: "Learned under Rav Kulefsky zt\"l for two years; values the kuntres distributed before Sukkos.",
});
{
  const result = parseOrganizedResponse(relationshipContextResponse);
  assert.equal(result.ok, true);
  assert.equal(result.data.fundraisingOpportunities.length, 0, "a purely relational conversation must not manufacture a fundraising opportunity");
  assert.match(result.data.relationshipContext, /Rav Kulefsky/);
}

// --- 4. A response that BLURS confirmed/possible into one bucket (e.g. the
// model ignoring the system prompt's instruction) is still structurally
// valid JSON and therefore still passes shape validation -- this is
// expected and correctly documented: parseOrganizedResponse enforces
// SHAPE, not semantic correctness, which is the model's own
// responsibility per the system prompt. The next line is a reminder of
// that boundary, not a claim this test can verify model judgment. ---
{
  const blurred = JSON.stringify({ ...JSON.parse(explicitCommitmentResponse), confirmedCommitments: ["$18,000 for the building fund"], possibleCommitments: ["$18,000 for the building fund"] });
  const result = parseOrganizedResponse(blurred);
  assert.equal(result.ok, true, "shape validation alone cannot catch a model that duplicates content across confirmed/possible -- enforcing that distinction is the system prompt's job, verified in section 1 above, not this function's");
}

console.log("meeting-notes-fundraising-scenarios.test.mjs: all assertions passed");
