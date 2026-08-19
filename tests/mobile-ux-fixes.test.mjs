import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation, summarizeRecommendationForSnapshot } from "../lib/relationships/recommendation-rank.ts";

// Four live mobile-usability issues observed after the shared-activity +
// Text Message rollout: (1) continue_conversation manufacturing useless
// "Continue the conversation about X" copy from a generic touch, plus the
// 2x2 KPI grid squeezing that prose into a half-width mobile column, (2)
// editing a shared activity silently editing every linked donor with no
// donor-specific alternative, (3) RecipientPicker's mobile search results
// overlapping, (4) same KPI layout issue as (1)'s second half.

const NOW = Math.floor(Date.parse("2026-08-18T12:00:00Z") / 1000);
const DAY = 86400;
const daysAgo = (n) => NOW - n * DAY;
const TIMEZONE = "America/New_York";

const emptyInput = {
  donorId: "donor-empty",
  mostRecentPaidGift: null,
  openPledge: null,
  lastCompletedInteraction: null,
  lastContactAt: null,
  lastSubstantiveContactAt: null,
  openReminder: null,
  relationshipSummary: null,
  institutionalMemory: null,
  historicalContext: [],
  yahrtzeits: [],
  importantDates: [],
};

async function run() {
  // --- 1: a generic Text Message with no meaningful next action produces
  // no useless mechanical paraphrase, and no candidate at all -- exactly
  // the real, observed live example ("Continue the conversation from the
  // recent text about 'Text message'.") must no longer occur. ---
  const genericTextInteraction = {
    type: "text",
    summary: "Text message\nJust checking in, nothing major to report.",
    occurredAt: daysAgo(2),
  };
  const genericTextEvidence = buildRecommendationEvidence({ ...emptyInput, lastCompletedInteraction: genericTextInteraction, lastContactAt: daysAgo(2), lastSubstantiveContactAt: daysAgo(2) }, NOW, TIMEZONE);
  const genericCandidates = generateCandidates(genericTextEvidence);
  assert.equal(genericCandidates.find((c) => c.kind === "continue_conversation"), undefined, "a completed interaction with no commitment language must not generate continue_conversation");
  const genericWinner = buildDonorRecommendation(genericTextEvidence);
  assert.equal(genericWinner, null, "with nothing else on file, a generic recent touch must honestly produce no recommendation at all");
  // The UI's own existing empty-state text is what a fundraiser actually
  // sees in this case -- proven at the source level in test 3 below.

  // --- 2: a real commitment in the note still surfaces a specific,
  // donor-relevant next action, and never shows the raw "text" enum value
  // where the friendly "Text Message" label belongs. ---
  const specificTextInteraction = {
    type: "text",
    summary: "Building tour follow-up\nWill send the updated pledge form by Friday.",
    occurredAt: daysAgo(2),
  };
  const specificEvidence = buildRecommendationEvidence({ ...emptyInput, lastCompletedInteraction: specificTextInteraction, lastContactAt: daysAgo(2), lastSubstantiveContactAt: daysAgo(2) }, NOW, TIMEZONE);
  const specificCandidate = generateCandidates(specificEvidence).find((c) => c.kind === "continue_conversation");
  assert.ok(specificCandidate, "a note naming a real commitment must still generate continue_conversation");
  assert.doesNotMatch(specificCandidate.action, /\btext\b(?!\s*message)/i, "the action text must never expose the raw 'text' enum value");
  assert.doesNotMatch(specificCandidate.action, /Continue the conversation from the recent/i, "the old mechanical channel+subject paraphrase must be gone entirely");
  assert.match(specificCandidate.why, /text message/i, "the why text should still name the channel, using the friendly label");
  const specificWinner = buildDonorRecommendation(specificEvidence);
  assert.equal(specificWinner.kind, "continue_conversation");

  // --- 3: the empty-state fallback a fundraiser actually sees for the
  // generic case above is the existing, honest "no suggestion" copy --
  // never a fabricated action. Checked at the source level since this
  // codebase has no component-rendering harness. ---
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(donorPage, /recommendationSummary\?\.headline \|\| "None available"/);
  assert.match(donorPage, /recommendation\?\.action \|\| "No suggested action available"/);

  // --- 3b: Suggested Action stays concise even for the specific-commitment
  // case -- reuses the existing snapshot-card summarizer and length
  // backstop, not a new one. ---
  const specificSummary = summarizeRecommendationForSnapshot(specificWinner);
  assert.ok(specificSummary.headline.length <= 100, "the Suggested Action KPI headline must stay within the existing concise-summary backstop");

  // --- 4: mobile Suggested Action layout spans full width beneath the
  // three numeric KPI tiles, instead of squeezing prose into a half-width
  // 2x2 column. ---
  const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globalsCss, /\.donor-snapshot-grid \{ grid-template-columns: repeat\(3, 1fr\); \}/, "the three numeric KPI tiles must lay out as compact columns on mobile");
  assert.match(globalsCss, /\.snapshot-card:last-child \{ grid-column: 1 \/ -1;/, "the Suggested Action card (last child) must span the full grid width on mobile");

  // --- 5: shared-activity edit UI clearly warns it affects every linked
  // donor, stated as a real number, not a vague caveat. ---
  const sharedActivityActions = await readFile(new URL("../app/components/SharedActivityActions.tsx", import.meta.url), "utf8");
  assert.match(sharedActivityActions, /recipientCount: number;/, "the component must receive the real linked-donor count as a prop");
  assert.match(sharedActivityActions, /This change affects all \{recipientCount\} donor\{recipientCount === 1 \? "" : "s"\}/, "the edit form must state the exact number of affected donors");
  assert.match(sharedActivityActions, /className="shared-activity-edit-warning"/, "the warning must be visually distinguished, not just plain field-help text");

  // --- 6/7/8: donor-specific note reuses the existing single-donor capture
  // path (prefilled via ?donorId=, same convention as the donor page's own
  // "+ Log interaction" link) rather than forking shared content or
  // inventing new schema. This structurally guarantees: (6) exactly one
  // interaction row is created (the existing single-donor POST route
  // creates exactly one row per submission -- unchanged, not touched by
  // this task); (7) shared_activities is never written by that route; (8)
  // the created row has no shared_activity_id, so later editing it via the
  // existing single-donor edit route can never touch the shared parent or
  // any other donor's timeline. ---
  assert.match(sharedActivityActions, /href=\{`\/capture\?donorId=\$\{encodeURIComponent\(donorId\)\}`\}/, "donor-specific note must launch the existing single-donor capture form for the current donor");
  assert.match(sharedActivityActions, /Add note for this donor/);
  const interactionsRoute = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(interactionsRoute, /shared_activit/i, "the single-donor capture route must never reference shared_activities -- a donor-specific note can structurally never mutate it");

  // --- 9/10: RecipientPicker mobile result rows -- no overlapping
  // positioning, and mobile-safe overflow behavior (the actual live bug:
  // a CSS grid with default auto row-sizing collapsed every row to a
  // uniform ~49px track regardless of wrapped multi-line content, so text
  // spilled into the next row -- confirmed live against the deployed page
  // before this fix). ---
  const recipientPicker = await readFile(new URL("../app/capture/RecipientPicker.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(recipientPicker, /position:\s*absolute/, "the recipient picker must not use an absolutely-positioned dropdown");
  assert.match(globalsCss, /\.recipient-picker-results \{ display:grid; grid-auto-rows:min-content;/, "each result row must size to its own true content height, not a shared implicit auto-row that ignores wrapped text");
  assert.match(globalsCss, /\.recipient-picker-result \.autocomplete-identity small \{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; \}/, "the secondary metadata line must truncate to one line rather than wrapping and colliding with the row below");
  assert.match(recipientPicker, /\[numericDonorCode\(\{ donorCode: donor\.code \}\), donor\.email \|\| donor\.phone\]/, "the secondary line must be restrained to code + one contact method, not every identity field joined together");

  // --- 11: already-selected donors still cannot be duplicated (unchanged
  // by this task -- Set-backed toggle, same as tests/shared-activity-ux
  // already covers; re-asserted here since RecipientPicker.tsx was edited). ---
  assert.match(recipientPicker, /const selectedSet = useMemo\(\(\) => new Set\(selectedIds\)/);
  assert.match(recipientPicker, /if \(selectedSet\.has\(donorId\)\) \{\s*onChange\(selectedIds\.filter/);

  console.log("Mobile UX fixes checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
