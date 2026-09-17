import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildIntelligenceBriefRows, groupIntelligenceBriefRows, groupForDisposition, INTELLIGENCE_GROUP_LABELS, INTELLIGENCE_GROUP_ORDER } from "../lib/fundraising-intelligence/dedicated-view.ts";
import { buildTodayIntelligenceTeaserRows, DEFAULT_TEASER_LIMIT } from "../lib/fundraising-intelligence/today-view.ts";
import { SITUATION_TYPE_LABELS, DISPOSITION_LABELS, CONFIDENCE_LABELS } from "../lib/fundraising-intelligence/labels.ts";

// Fundraising Intelligence Brief -- UI phase tests. Adapter-level tests
// use synthetic FundraisingIntelligenceCandidate fixtures directly (the
// engine's own selection/synthesis logic is already covered exhaustively
// in tests/fundraising-intelligence.test.mjs) -- this file only proves
// the UI adapters (lib/fundraising-intelligence/{dedicated-view,
// today-view,labels}.ts) faithfully preserve and translate the engine's
// already-computed output, never re-derive or re-rank anything. File-
// content tests mirror tests/today.test.mjs's own convention for
// asserting real component wiring.

function candidate(overrides) {
  return {
    donorId: "x", displayName: "Test Donor", disposition: "DO", situationType: "pledge_follow_up",
    headline: "Headline", explanation: "Explanation.", whyNow: "Why now.", whatFosDoesNotKnow: null,
    possibleAction: "Do the thing.", confidence: "medium", sourceSignals: [{ kind: "pledge_balance", detail: "Some evidence." }],
    included: true, suppressionReason: null,
    debug: { portfolioFocusRank: 5, compositeScore: 0.5, financialSignificance: 0.6, recommendationKind: null, recommendationScore: null, priorityTier: 1 },
    ...overrides,
  };
}

async function run() {
  // ---------------- Adapter preserves order, count, and identity (no donor outside the Brief, no item silently dropped) ----------------
  {
    const items = [
      candidate({ donorId: "a", disposition: "DO" }),
      candidate({ donorId: "b", disposition: "KNOW", possibleAction: null }),
      candidate({ donorId: "c", disposition: "KNOW_DO" }),
    ];
    const rows = buildIntelligenceBriefRows(items);
    assert.deepEqual(rows.map((r) => r.donorId), ["a", "b", "c"], "row order must exactly match the engine's own item order");
    assert.equal(rows.length, items.length, "every included item must produce exactly one row -- none dropped, none duplicated");
  }

  // ---------------- Situation labels map correctly (all 8 types, centralized) ----------------
  {
    const expected = {
      explicit_follow_up: "Follow-up", stewardship_moment: "Stewardship", commitment_progress: "Commitment progress",
      pledge_follow_up: "Pledge follow-up", financial_change: "Giving change", relationship_visibility: "Relationship visibility",
      ask_resolution: "Ask update", upcoming_moment: "Upcoming moment",
    };
    for (const [situationType, label] of Object.entries(expected)) {
      const [row] = buildIntelligenceBriefRows([candidate({ situationType })]);
      assert.equal(row.situationLabel, label, `${situationType} must map to "${label}"`);
      assert.equal(SITUATION_TYPE_LABELS[situationType], label);
    }
  }

  // ---------------- Disposition grouping (DO / KNOW+DO / KNOW, never by technical situation type) ----------------
  {
    assert.equal(groupForDisposition("DO"), "needs_action");
    assert.equal(groupForDisposition("KNOW_DO"), "worth_knowing_and_doing");
    assert.equal(groupForDisposition("KNOW"), "worth_knowing");
    const items = [
      candidate({ donorId: "do1", disposition: "DO" }),
      candidate({ donorId: "know1", disposition: "KNOW", possibleAction: null }),
      candidate({ donorId: "knowdo1", disposition: "KNOW_DO" }),
      candidate({ donorId: "do2", disposition: "DO" }),
    ];
    const groups = groupIntelligenceBriefRows(buildIntelligenceBriefRows(items));
    assert.deepEqual(groups.needs_action.map((r) => r.donorId), ["do1", "do2"]);
    assert.deepEqual(groups.worth_knowing_and_doing.map((r) => r.donorId), ["knowdo1"]);
    assert.deepEqual(groups.worth_knowing.map((r) => r.donorId), ["know1"]);
    assert.deepEqual(INTELLIGENCE_GROUP_ORDER, ["needs_action", "worth_knowing_and_doing", "worth_knowing"]);
    assert.equal(INTELLIGENCE_GROUP_LABELS.needs_action, "Needs Action");
  }

  // ---------------- KNOW item never gains an action; DO/KNOW_DO always keeps its supported action ----------------
  {
    const [knowRow] = buildIntelligenceBriefRows([candidate({ disposition: "KNOW", possibleAction: null })]);
    assert.equal(knowRow.possibleAction, null, "a KNOW row must never gain an action the engine did not supply");
    const [doRow] = buildIntelligenceBriefRows([candidate({ disposition: "DO", possibleAction: "Follow up." })]);
    assert.equal(doRow.possibleAction, "Follow up.");
  }

  // ---------------- No raw score or internal enum exposed by the adapter's own row shape ----------------
  {
    const [row] = buildIntelligenceBriefRows([candidate({})]);
    const keys = Object.keys(row);
    for (const forbidden of ["compositeScore", "recommendationScore", "recommendationKind", "priorityTier", "confidence", "suppressionReason"]) {
      assert.ok(!keys.includes(forbidden), `IntelligenceBriefRow must never carry the internal field "${forbidden}"`);
    }
    assert.equal(row.confidenceLabel, CONFIDENCE_LABELS.medium, "confidence must be translated to plain language, never the raw enum");
    assert.equal(row.dispositionLabel, DISPOSITION_LABELS.DO);
    // Evidence lines must be plain sentences, never carry the internal `kind` tag.
    assert.deepEqual(row.evidenceLines, ["Some evidence."]);
  }

  // ---------------- Today teaser: max 3, prioritizes DO/KNOW_DO deterministically ----------------
  {
    assert.equal(DEFAULT_TEASER_LIMIT, 3);
    const items = [
      candidate({ donorId: "know-a", disposition: "KNOW", possibleAction: null, debug: { ...candidate().debug, portfolioFocusRank: 1 } }),
      candidate({ donorId: "do-a", disposition: "DO" }),
      candidate({ donorId: "knowdo-a", disposition: "KNOW_DO" }),
      candidate({ donorId: "do-b", disposition: "DO" }),
      candidate({ donorId: "know-b", disposition: "KNOW", possibleAction: null }),
    ];
    const teaser = buildTodayIntelligenceTeaserRows(items);
    assert.equal(teaser.length, 3, "the teaser must never exceed 3 items");
    assert.deepEqual(teaser.map((r) => r.donorId), ["do-a", "knowdo-a", "do-b"], "DO/KNOW_DO items must fill the teaser first, in Brief order, ahead of any pure-KNOW item");
  }

  // ---------------- Today teaser: backfills with KNOW when too few actionable items exist ----------------
  {
    const items = [
      candidate({ donorId: "do-only", disposition: "DO" }),
      candidate({ donorId: "know-1", disposition: "KNOW", possibleAction: null }),
      candidate({ donorId: "know-2", disposition: "KNOW", possibleAction: null }),
    ];
    const teaser = buildTodayIntelligenceTeaserRows(items);
    assert.deepEqual(teaser.map((r) => r.donorId), ["do-only", "know-1", "know-2"], "with only one actionable item, KNOW items must backfill the remaining teaser slots");
  }

  // ---------------- Today teaser: zero DO/KNOW_DO -- shows the single strongest KNOW item, not an empty teaser or 3 KNOW items ----------------
  {
    const items = [
      candidate({ donorId: "know-1", disposition: "KNOW", possibleAction: null }),
      candidate({ donorId: "know-2", disposition: "KNOW", possibleAction: null }),
    ];
    const teaser = buildTodayIntelligenceTeaserRows(items);
    assert.equal(teaser.length, 1, "with zero actionable items, exactly one KNOW item is shown -- not zero (a quiet empty state), not the full KNOW set");
    assert.equal(teaser[0].donorId, "know-1");
  }

  // ---------------- Today teaser derives from the Brief, never a second selection engine ----------------
  {
    const briefModuleSrc = await readFile(new URL("../lib/fundraising-intelligence/today-view.ts", import.meta.url), "utf8");
    assert.doesNotMatch(briefModuleSrc, /cloudflare:workers|env\.DB/, "the Today teaser adapter must stay pure/read-only, with no D1 access of its own");
    assert.doesNotMatch(briefModuleSrc, /sort\(|\.rank\s*=/, "the teaser must not re-sort or re-rank -- only filter/slice the engine's own already-ordered items");
  }

  // ---------------- File-content wiring: Today page ----------------
  {
    const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    assert.match(today, /Fundraising Intelligence/);
    assert.match(today, /intelligenceTeaserRows\.length > 0/, "the teaser section must be entirely omitted when there are zero results");
    assert.ok(today.indexOf("today-command-grid") < today.indexOf("fib-teaser-section"), "the teaser must render below Today's Agenda / Coming Up, never above or inside it");
    assert.match(today, /try \{[\s\S]*?computePortfolioFocusAndBrief\(profile\.id, profile\.timezone, now\)[\s\S]*?\} catch \(error\) \{[\s\S]*?logger\.error\("today_strategic_sections_load_failed", error, \{ userId: profile\.id \}\);[\s\S]*?\}/, "a Brief computation failure must be caught and logged, never thrown");
    assert.doesNotMatch(today.split("fib-teaser-section")[1]?.split("portfolio-focus-section")[0] ?? "", /throw /, "the teaser section's own render path must never rethrow");
    assert.match(styles, /\.fib-teaser-section \{ margin-bottom:22px; border-top:3px solid #5b7a9a; \}/, "the teaser must use its own distinct accent color, never Portfolio Focus's or Today's Agenda's");
    assert.doesNotMatch(styles, /\.fib-teaser-section \{[^}]*#8a9a5b/, "the teaser accent must not copy Portfolio Focus's accent");
    // No task-management controls in the teaser markup specifically (Today
    // legitimately has unrelated task controls elsewhere, e.g. scheduled
    // activities -- scope the check to the Fundraising Intelligence
    // section/component only).
    const stripComments = (src) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const teaserSlice = stripComments(today.slice(today.indexOf("function FundraisingIntelligenceTeaserRow"), today.indexOf("export default async function TodayPage")));
    const experience = stripComments(await readFile(new URL("../app/fundraising-intelligence/FundraisingIntelligenceExperience.tsx", import.meta.url), "utf8"));
    for (const forbidden of ["type=\"checkbox\"", "Mark complete", "Snooze", "due date", "overdue"]) {
      assert.doesNotMatch(teaserSlice + experience, new RegExp(forbidden, "i"), `no task-management control ("${forbidden}") may appear in Brief UI's actual markup -- this phase is intelligence display, not task management`);
    }
  }

  // ---------------- File-content wiring: dedicated page ----------------
  {
    const dedicatedPage = await readFile(new URL("../app/fundraising-intelligence/page.tsx", import.meta.url), "utf8");
    const experience = await readFile(new URL("../app/fundraising-intelligence/FundraisingIntelligenceExperience.tsx", import.meta.url), "utf8");
    assert.match(dedicatedPage, /Fundraising Intelligence/);
    assert.match(dedicatedPage, /What deserves your attention right now/);
    for (const forbidden of ["Pipeline", "Moves", "Opportunities", "CRM", "Tasks"]) assert.doesNotMatch(dedicatedPage, new RegExp(`\\b${forbidden}\\b`));
    assert.match(dedicatedPage, /try \{[\s\S]*?computeFundraisingIntelligenceBrief\(profile\.id, profile\.timezone, now\)[\s\S]*?\} catch \(error\) \{[\s\S]*?logger\.error\("fundraising_intelligence_dedicated_load_failed"/, "a dedicated-page computation failure must be caught and logged, never thrown");
    assert.match(dedicatedPage, /Nothing significant needs your attention right now/, "the zero-item state must use restrained, non-fabricated language");
    assert.match(experience, /donorNavigationHref\(row\.donorId, "\/fundraising-intelligence", "fundraising-intelligence"\)/, "donor links must use the existing donor-navigation convention with the correct origin");
    assert.match(experience, /<details className="fib-evidence">/, "evidence disclosure must use native, keyboard-accessible <details>/<summary>, not a bespoke JS toggle");
    // No raw scores/technical fields ever referenced in the dedicated-page component.
    for (const forbidden of ["compositeScore", "financialSignificance", "recommendationScore", "recommendationKind", "priorityTier", "suppressionReason", "debug\\."]) {
      assert.doesNotMatch(experience, new RegExp(forbidden), `the dedicated-page component must never reference the internal field "${forbidden}"`);
    }
  }

  // ---------------- Donor navigation: new origin registered, no second routing pattern ----------------
  {
    const nav = await readFile(new URL("../lib/navigation/donor-navigation.ts", import.meta.url), "utf8");
    assert.match(nav, /"fundraising-intelligence"/);
    assert.match(nav, /Back to Fundraising Intelligence/);
  }

  console.log("fundraising-intelligence-ui.test.mjs: all assertions passed");
}

run();
