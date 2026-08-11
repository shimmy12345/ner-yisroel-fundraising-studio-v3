import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function run() {
  const ui = await read("app/donors/[id]/DonorResearch.tsx");
  const page = await read("app/donors/[id]/page.tsx");
  const styles = await read("app/globals.css");
  const schema = await read("db/schema.ts");

  // ---- Donor-page placement: a restrained story-card, live-mode only,
  // with an honest empty state before any research has been run. ----
  assert.match(page, /import \{ DonorResearch, type IdentityCandidateView, type PendingEvidenceView, type ResearchFindingView, type ResearchSourceView \} from "\.\/DonorResearch"/);
  assert.match(ui, /className="story-card donor-research-card"/);
  assert.match(ui, />Research this donor</);
  assert.match(ui, /Nothing is fetched automatically/i, "the empty state is honest about the manual-entry workflow, not implying automatic discovery");

  // ---- Six sections named exactly as approved, no fabricated seventh. ----
  const categoryLabels = ["Professional", "Boards & Affiliations", "Public Philanthropy", "Recent Mentions", "Shared Public Affiliations", "Research Notes / Ambiguities"];
  for (const label of categoryLabels) assert.match(ui, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(ui, /professional.*boards_affiliations.*public_philanthropy.*recent_mentions.*possible_connections.*notes_ambiguities/s, "the six categories are wired in the documented order");

  // ---- Identity confirmation is a required, visible gate in the UI --
  // there is no way to reach the findings display without it. ----
  assert.match(ui, /CONFIRM IDENTITY/);
  assert.match(ui, /Confirm this is the right person before any finding is recorded/i);
  assert.match(ui, />Confirm identity</);
  assert.match(ui, />Not the right person</);
  assert.match(ui, /openRun\.pendingEvidence\.some\(\(item\) => !tierChoices\[item\.id\]\)/, "the confirm button stays disabled until every piece of evidence has an explicit source tier chosen");

  // ---- Source-first, restrained rendering: claim, source, publisher,
  // date, link -- and never a numeric confidence score anywhere. ----
  assert.match(ui, /Source: \{source\.publisher \|\| source\.title\}/);
  assert.match(ui, /research-unverified-tag/, "weak-tier findings are labeled Unverified rather than presented as confirmed");
  assert.doesNotMatch(ui, /\d+% confiden|confidenceScore|internalConfidence/i);
  assert.doesNotMatch(ui, /AI confidence|sentiment|extraction status/i);

  // ---- Shared Public Affiliations wording never implies an interpersonal
  // relationship. ----
  assert.doesNotMatch(ui, /\b(friend|friendship|close relationship|influence|acquainted)\b/i);

  // ---- No dead monitoring UI: Stage A explicitly ships without it. ----
  assert.doesNotMatch(ui, /monitor|Monitor this donor/i);
  assert.doesNotMatch(page, /Monitor this donor/i);
  assert.doesNotMatch(schema, /donorResearchMonitors/);

  // ---- Styling stays in the established restrained visual language --
  // reuses story-card conventions, doesn't invent a competing style. ----
  assert.match(styles, /\.donor-research-card/);
  assert.match(styles, /\.research-unverified-tag/);

  process.stdout.write("Donor research UX checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
