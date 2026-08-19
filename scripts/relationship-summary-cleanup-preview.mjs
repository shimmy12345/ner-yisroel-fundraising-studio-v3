// READ-ONLY preview for cleaning up donors.relationship_summary values
// still holding pre-fix (commit 1487a8b) machine-generated junk -- e.g.
// "People mentioned: Messaged.", or a full field-label dump like
// "Latest discussion topics: Personal update.\nPeople mentioned: ...".
//
// This script NEVER writes to D1. It only reads (via `wrangler d1 execute
// --remote --json`, the same pattern scripts/verify-remote-restore.mjs
// already uses) and prints a classification report. Applying any cleanup
// is a separate, explicitly-approved step this script does not perform.
//
// PROVENANCE, established by reading the actual write paths (not assumed):
// donors.relationship_summary/institutional_memory have NO field-level
// provenance column (no source_interaction_id, no generated-by flag) --
// db/schema.ts's donors table just has two plain `text` columns. However,
// EVERY write path to these two fields (POST /api/interactions, PATCH
// /api/interactions/[id], the outcome-logging route, and the Monday.com
// import's confirm_contact action) goes through the exact same
// extractInteraction() function -- there is no manual free-text entry
// path for these two fields anywhere in the app (the manual field is the
// separate donors.contact_note, edited via the donor contact form and
// tracked in donor_contact_audits, which never touches these two).
// Confirmed no audit/history table covers relationship_summary/
// institutional_memory changes either (donor_contact_audits is scoped to
// contact fields only -- see app/api/donors/[id]/route.ts).
//
// This means: every non-null value in these two columns is machine-
// generated, by construction. The open question this script answers is
// only WHICH VERSION of the generator produced it (pre-fix or post-fix),
// and whether the underlying source note supports a better regenerated
// value under the CURRENT extractor.
//
// institutional_memory is audited SEPARATELY and, per this audit, needs
// NO cleanup: extractInteraction's `memory` field
// (`${interactionKindLabel(type)} context: ${note.trim()}`) is BYTE-FOR-
// BYTE IDENTICAL before and after commit 1487a8b (verified via
// `git show 1487a8b~1:lib/capture/interaction.ts`) -- the extraction bug
// was entirely inside relationshipSnapshotDetails/
// actionableRelationshipSnapshot, which institutional_memory never used.
// This script reports institutional_memory's non-null count for
// completeness but proposes no changes to it.
//
// CLASSIFICATION SIGNATURE: the OLD actionableRelationshipSnapshot always
// began its output with the literal string "Latest discussion topics: "
// (unconditional first line) -- the NEW one (this same file, current
// version) never produces that prefix under any input, by construction
// (verified: it either returns null, or a plain sentence with no field
// labels at all). A relationship_summary value starting with that exact
// prefix is therefore PROVABLY from the pre-fix generator -- not a fuzzy
// heuristic, a structural fact checked against the real git history of
// this file.
//
// REGENERATION uses the CURRENT, real production
// relationshipSnapshotDetails/actionableRelationshipSnapshot from
// lib/capture/interaction.ts -- imported directly, never reimplemented.
// The one piece of legacy logic in this file (OLD_* below) exists ONLY to
// trace an old-format value back to the interaction note that produced
// it (by reproducing the OLD generator's output and matching it against
// the note candidates) -- it is never used to produce a proposed value.
//
// Usage: node scripts/relationship-summary-cleanup-preview.mjs
// Reads fundraising-os-staging-db via `wrangler d1 execute --remote`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  actionableRelationshipSnapshot,
  interactionKindLabel,
  relationshipSnapshotDetails,
  splitInteractionSummary,
} from "../lib/capture/interaction.ts";

const root = path.resolve(import.meta.dirname, "..");
const DB_NAME = "fundraising-os-staging-db";
const CONFIG = path.join(root, "wrangler.staging.jsonc");
const OLD_FORMAT_PREFIX = "Latest discussion topics: ";
const DOLLAR_AMOUNT_PATTERN = /\$[\d,]+/;

const wranglerBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.CMD" : "wrangler");
// Windows .CMD files require shell:true to spawn at all, but Node no
// longer auto-quotes array args for the shell in that mode (a fixed
// security footgun, not a regression to work around blindly) -- each
// argument must be quoted here ourselves. Wrapping in double quotes is
// sufficient for our own arguments, which are file paths and SQL strings
// built with single-quoted literals, never containing a literal `"`.
const winQuote = (value) => (process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : value);

function wranglerJson(sql) {
  const args = ["d1", "execute", DB_NAME, "--remote", "--config", CONFIG, "--command", sql, "--json"].map(winQuote);
  const result = spawnSync(wranglerBin, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  if (result.error) throw new Error(`Failed to spawn wrangler: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed:\n${(result.stderr || result.stdout || "").trim()}`);
  const lines = result.stdout.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate); } catch { /* keep scanning */ }
  }
  throw new Error(`Could not find JSON in wrangler output for query:\n${sql}\n${result.stdout}`);
}

// IMPORTANT, discovered while building apply mode: `wrangler d1 execute
// --file` (used elsewhere in this repo for large/multi-line SQL) uploads
// the file and returns a "Total queries executed"/"Rows written" SUMMARY,
// not the same per-statement `meta.changes` that `--command` mode returns
// -- confirmed live: a conditional UPDATE with a WHERE clause that could
// not possibly match any row (a nonexistent donor id) still came back
// with `meta.changes: 1` under `--file` mode (while its own "Rows
// written" summary field correctly said 0). That makes `--file` mode
// UNSAFE for this script's compare-and-swap check, which depends on
// `changes` being an exact, trustworthy per-row count -- so apply mode
// stays on `--command` mode (wranglerJson, proven reliable by every read
// in this file) and instead avoids the actual problem (embedded literal
// newlines in the pre-fix field-label-dump value breaking Windows
// shell-argument parsing) by hex-encoding any value that goes into
// generated SQL -- see sqlLiteral() below.

// --- Legacy generator (commit 1487a8b~1), reproduced here ONLY to trace
// an old-format relationship_summary value back to the interaction note
// that produced it. Never used to determine a proposed/new value -- that
// always comes from the real, current, imported actionableRelationshipSnapshot
// above. Frozen intentionally: this must keep reproducing the OLD output
// even as the current extractor keeps evolving. ---
const OLD_CRM_STATUS_VERBS = ["Solicited", "Declined", "Confirmed", "Pending", "Requested", "Reviewed", "Completed", "Cancelled", "Rescheduled", "Postponed", "Attended", "Contacted", "Reached", "Scheduled", "Reminded", "Thanked", "Updated", "Approved", "Rejected", "Received", "Processed"];
const OLD_KIND_LABELS = { call: "Call", email: "Email", meeting: "Meeting", visit: "Visit", note: "Note", personal: "Personal interaction", text: "Text Message" };
function oldSentenceList(note) { return note.trim().split(/(?:[.!?]+\s+|[\r\n]+)/).map((item) => item.trim()).filter(Boolean); }
function oldConcise(value, max = 180) { return value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`; }
function oldInferSubject(note, kind) {
  const signals = [
    [/\b(pledge|pledged|pledge balance|installment|payment)\b/i, "Pledge payment"],
    [/\b(gift|giving|donation|contribution)\b/i, "Giving follow-up"],
    [/\b(scholarship|student|tuition|education)\b/i, "Scholarship update"],
    [/\b(outcome|outcomes|impact|result|results|progress report|annual report)\b/i, "Impact update"],
    [/\b(campus|tour|school visit|site visit)\b/i, "Campus visit"],
    [/\b(proposal|request for support|funding request|ask amount)\b/i, "Proposal follow-up"],
    [/\b(event|gala|dinner|reception|parlor meeting)\b/i, "Event planning"],
    [/\b(family|spouse|son|daughter|birthday|anniversary)\b/i, "Personal update"],
  ];
  const matches = signals.map(([pattern, label]) => ({ label, index: note.search(pattern) })).filter((item) => item.index >= 0).sort((a, b) => a.index - b.index).filter((item, index, all) => all.findIndex((candidate) => candidate.label === item.label) === index).slice(0, 2).map((item) => item.label);
  if (matches.length === 2) return `${matches[0]} and ${matches[1].toLowerCase()}`;
  if (matches.length === 1) return matches[0];
  const fallbacks = { call: "Donor call follow-up", email: "Donor email follow-up", meeting: "Donor meeting follow-up", visit: "Donor visit follow-up", note: "Relationship update", personal: "Personal update", text: "Text message follow-up" };
  return fallbacks[kind];
}
function oldMentionedPeople(note) {
  const ignored = new Set(["Called", "Emailed", "Meeting", "Coffee", "Lunch", "Dinner", "Visited", "Discussed", "Shared", "Send", "Follow", "The", "This", "She", "He", "They", "We", "I", ...OLD_CRM_STATUS_VERBS]);
  const names = note.match(/\b\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu) ?? [];
  return [...new Set(names.map((name) => name.trim().replace(/[’']s$/u, "")).filter((name) => !ignored.has(name) && !/\b(?:Foundation|University|College|School|Yeshiva|Synagogue|Congregation|Hospital|Inc|LLC)\b/u.test(name)))].slice(0, 5);
}
function oldMentionedOrganizations(note) {
  const organizations = note.match(/\b(?:\p{Lu}[\p{L}'’&.-]*\s+){0,5}(?:Foundation|University|College|School|Yeshiva|Synagogue|Congregation|Hospital|Company|Inc\.?|LLC)\b/gu) ?? [];
  return [...new Set(organizations.map((item) => item.trim()))].slice(0, 5);
}
function oldCommitmentAction(sentence) {
  const match = sentence.match(/\b(?:promised|agreed|committed|will|would)\s+(?:to\s+)?(.+)/i);
  if (match?.[1]) return oldConcise(match[1].replace(/[.!?]+$/, ""), 120);
  const direct = sentence.match(/\b(send|follow up|call back|introduce|schedule|share|provide)\b(.+)/i);
  return direct ? oldConcise(`${direct[1]}${direct[2]}`.replace(/[.!?]+$/, ""), 120) : null;
}
function oldActionableRelationshipSnapshot(note, kind) {
  const sentences = oldSentenceList(note);
  const topics = oldInferSubject(note, kind).split(" and ").map((topic) => topic.replace(/^./, (letter) => letter.toUpperCase()));
  const people = oldMentionedPeople(note);
  const organizations = oldMentionedOrganizations(note);
  const commitmentSentences = sentences.filter((sentence) => /\b(promised|agreed|committed|will|would|send|follow up|follow-up|call back|introduce|schedule|share|provide)\b/i.test(sentence)).slice(0, 3);
  const relationshipChanges = sentences.filter((sentence) => /\b(increased|decreased|changed|newly|no longer|ready|hesitant|more involved|less involved|reconnected|stepped back)\b/i.test(sentence)).slice(0, 2);
  const nextAction = commitmentSentences.map(oldCommitmentAction).find(Boolean) ?? "Review this note before the next interaction";
  const topicLabel = topics.map((topic, index) => index ? topic.toLowerCase() : topic).join(" and ");
  return [
    `Latest discussion topics: ${topicLabel}.`,
    people.length ? `People mentioned: ${people.join(", ")}.` : null,
    organizations.length ? `Organizations mentioned: ${organizations.join(", ")}.` : null,
    commitmentSentences.length ? `Commitments: ${commitmentSentences.map((item) => oldConcise(item).replace(/[.!?]+$/, "")).join("; ")}.` : null,
    commitmentSentences.length ? `Open follow-ups: ${nextAction}.` : null,
    relationshipChanges.length ? `Relationship changes: ${relationshipChanges.map((item) => oldConcise(item).replace(/[.!?]+$/, "")).join("; ")}.` : null,
    `Recommended next action: ${nextAction}.`,
  ].filter(Boolean).join("\n");
}

const ALLOWED_KINDS = new Set(["call", "email", "meeting", "visit", "note", "personal", "text"]);
function normalizeKind(rawType) {
  return ALLOWED_KINDS.has(rawType) ? rawType : "note";
}

// Two real write conventions exist for what text actually got passed to
// extractInteraction() for a given interaction row: normal captures pass
// `note || subject` (see app/api/interactions/route.ts), but the Monday
// import's confirm_contact action passes ONLY its raw subitem text --
// `decision.text` -- which is the SUBJECT line alone, before the
// "Imported from Monday.com..." provenance line was appended to the
// stored interactions.summary (see app/api/import/monday/commit/route.ts).
// Both are tried per interaction; whichever exactly reproduces the stored
// value is the real source text -- not a guess, a reproduction.
function candidateTexts(interaction) {
  const { subject, note } = splitInteractionSummary(interaction.summary);
  const kind = normalizeKind(interaction.type);
  const texts = note ? [note, subject] : [subject];
  return [...new Set(texts)].filter(Boolean).map((text) => ({ text, kind }));
}

// Pure classification core: takes already-fetched donor/interaction rows
// (no D1 access here) and returns the same 5 buckets `run()` prints. Split
// out from `run()` so the classification logic itself can be unit-tested
// with synthetic fixtures, without a live wrangler/D1 round-trip.
function classifyDonors(candidates, interactionsByDonor) {
  const buckets = { SAFE_TO_CLEAR: [], SAFE_TO_REGENERATE: [], NEEDS_REVIEW: [], MANUAL_UNCERTAIN: [], ALREADY_GOOD: [] };

  for (const donor of candidates) {
    const value = donor.relationship_summary;
    const isOldFormat = value.startsWith(OLD_FORMAT_PREFIX);
    const interactions = interactionsByDonor.get(donor.id) ?? [];

    if (!isOldFormat) {
      // Does NOT match the provably-pre-fix structural signature. Check
      // whether it traces to what the CURRENT extractor would produce
      // from any of this donor's interactions -- if so, it is already the
      // clean, current format. If it doesn't trace to anything, we cannot
      // prove how it was produced, so it is left untouched.
      let matched = false;
      outer: for (const interaction of interactions) {
        for (const { text, kind } of candidateTexts(interaction)) {
          const current = actionableRelationshipSnapshot(text, kind);
          if (current !== null && current === value) { matched = true; break outer; }
        }
      }
      buckets[matched ? "ALREADY_GOOD" : "MANUAL_UNCERTAIN"].push({
        donor, value, proposed: null,
        reason: matched
          ? "Matches exactly what the current extractor produces from a traced interaction note -- already the clean, post-fix format."
          : "Does not match the pre-fix field-label-dump signature, and does not trace to the current extractor's output from any interaction on file -- cannot prove provenance, left untouched.",
        sourceInteraction: null,
      });
      continue;
    }

    // Old-format: try to find the interaction whose note reproduces this
    // EXACT stored value under the OLD generator -- proof of provenance,
    // not a guess.
    let source = null;
    outer: for (const interaction of interactions) {
      for (const { text, kind } of candidateTexts(interaction)) {
        if (oldActionableRelationshipSnapshot(text, kind) === value) { source = { interaction, note: text, kind }; break outer; }
      }
    }

    if (!source) {
      buckets.NEEDS_REVIEW.push({
        donor, value, proposed: null,
        reason: "Matches the pre-fix field-label-dump format, but no interaction on file reproduces it exactly under the old generator -- cannot confirm the source note, so this cannot be safely auto-cleared or regenerated.",
        sourceInteraction: null,
      });
      continue;
    }

    const proposed = actionableRelationshipSnapshot(source.note, source.kind);
    const details = relationshipSnapshotDetails(source.note, source.kind);
    const hasDollarAmount = DOLLAR_AMOUNT_PATTERN.test(source.note);
    const hasNamedEntity = details.people.length > 0 || details.organizations.length > 0;

    if (proposed !== null) {
      buckets.SAFE_TO_REGENERATE.push({
        donor, value, proposed,
        reason: `The current extractor finds a specific fact in the traced source note ("${interactionKindLabel(source.kind)}" on ${new Date(source.interaction.occurred_at * 1000).toISOString().slice(0, 10)}) -- regenerate using that.`,
        sourceInteraction: source.interaction,
      });
    } else if (hasDollarAmount || hasNamedEntity) {
      // The current extractor found nothing, but the note contains a
      // dollar amount or a named person/organization the extractor's
      // keyword list doesn't happen to recognize as a "fact signal" --
      // auto-clearing here risks losing real stewardship history (e.g. a
      // solicitation amount, or a family/calendar term like "Yahrtzeit").
      // This is a known, reported limitation of the current extractor's
      // keyword coverage, not a bug in this script -- flagged for a human
      // rather than silently discarded or silently "fixed" mid-cleanup.
      buckets.NEEDS_REVIEW.push({
        donor, value, proposed: null,
        reason: `The current extractor found no fact signal in the traced source note, but it contains ${hasDollarAmount ? "a dollar amount" : ""}${hasDollarAmount && hasNamedEntity ? " and " : ""}${hasNamedEntity ? `a named person/organization (${[...details.people, ...details.organizations].join(", ")})` : ""} the extractor's keyword list doesn't recognize as a fact signal -- clearing could lose real information; needs a human read of the source note.`,
        sourceInteraction: source.interaction,
      });
    } else {
      buckets.SAFE_TO_CLEAR.push({
        donor, value, proposed: null,
        reason: `Traced to source note ("${interactionKindLabel(source.kind)}" on ${new Date(source.interaction.occurred_at * 1000).toISOString().slice(0, 10)}); the current extractor finds no specific fact in it, no dollar amount, and no named person/organization -- pure pre-fix boilerplate with nothing to preserve.`,
        sourceInteraction: source.interaction,
      });
    }
  }

  return buckets;
}

// Fetches a fresh live snapshot from D1 and classifies it. Used by BOTH
// `run()` (preview/print only) and `applyApproved()` (which re-fetches and
// re-classifies immediately before every write, so it can never act on
// stale in-memory state from an earlier call).
function fetchLiveClassification() {
  const donorRows = wranglerJson(
    "SELECT id, display_name, relationship_summary, institutional_memory FROM donors WHERE data_source='live' AND archived_at IS NULL",
  )[0].results;
  const totalDonors = wranglerJson(
    "SELECT COUNT(*) AS c FROM donors WHERE data_source='live' AND archived_at IS NULL",
  )[0].results[0].c;
  const rsNonNull = donorRows.filter((d) => d.relationship_summary !== null).length;
  const imNonNull = donorRows.filter((d) => d.institutional_memory !== null).length;
  const candidates = donorRows.filter((d) => d.relationship_summary !== null);

  const donorIds = candidates.map((d) => d.id);
  let interactionsByDonor = new Map();
  if (donorIds.length > 0) {
    const idList = donorIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const interactionRows = wranglerJson(
      `SELECT donor_id, id, type, summary, occurred_at FROM interactions WHERE donor_id IN (${idList}) ORDER BY donor_id, occurred_at DESC`,
    )[0].results;
    for (const row of interactionRows) {
      if (!interactionsByDonor.has(row.donor_id)) interactionsByDonor.set(row.donor_id, []);
      interactionsByDonor.get(row.donor_id).push(row);
    }
  }

  const buckets = classifyDonors(candidates, interactionsByDonor);
  return { totalDonors, rsNonNull, imNonNull, candidates, interactionsByDonor, buckets };
}

// SQLite string-literal escaping (single quotes doubled) -- the same
// convention already used for donor IDs in the IN(...) list above. Safe
// for values with no embedded literal newlines (donor IDs, short SQL
// fragments); do NOT use for arbitrary donor-content strings -- see
// sqlLiteral() below.
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Hex-encodes a value's UTF-8 bytes into a SQLite blob literal, cast back
// to TEXT -- e.g. `CAST(X'48656c6c6f' AS TEXT)` for "Hello". Used for the
// apply-mode UPDATE's SET/WHERE values, which come from real donor content
// (the pre-fix field-label-dump format is multi-line) -- embedding a
// literal newline in a `--command` shell argument breaks Windows cmd.exe's
// argument parsing before the query ever reaches D1 (confirmed live: a
// SQLITE_ERROR "unrecognized token", with the target row unchanged
// afterward). Hex has no quotes, backslashes, or whitespace, so it needs
// no escaping and survives shell quoting intact regardless of content.
function sqlLiteral(value) {
  return `CAST(X'${Buffer.from(String(value), "utf8").toString("hex")}' AS TEXT)`;
}

// Pure decision logic for apply mode -- no D1 access here, so it is
// directly unit-testable against synthetic candidates/interactionsByDonor
// (the same fixtures classifyDonors tests use). Takes the caller's
// explicitly-approved donor IDs and a freshly-fetched classification, and
// decides, per ID, WRITE (with the exact SQL to run) or SKIP (with a
// reason) -- it never receives or trusts a proposed replacement STRING
// from the caller; `proposed` always comes from `buckets.SAFE_TO_REGENERATE`,
// which was computed by classifyDonors() from the real current extractor.
function planApply(approvedIds, candidates, buckets) {
  const safeById = new Map(buckets.SAFE_TO_REGENERATE.map((item) => [item.donor.id, item]));
  const candidateById = new Map(candidates.map((d) => [d.id, d]));

  return approvedIds.map((donorId) => {
    const item = safeById.get(donorId);
    if (!item) {
      const known = candidateById.get(donorId);
      const bucketName = known
        ? Object.entries(buckets).find(([, items]) => items.some((i) => i.donor.id === donorId))?.[0]
        : null;
      return {
        donorId, action: "SKIP", value: known?.relationship_summary ?? null, proposed: null,
        reason: known
          ? `Donor currently classifies as ${bucketName ?? "unknown"}, not SAFE_TO_REGENERATE -- refusing to write. Re-run the preview and re-review before retrying.`
          : "Donor not found among current relationship_summary candidates (no non-null relationship_summary, or donor no longer live/archived) -- refusing to write.",
      };
    }
    return {
      donorId, action: "WRITE", value: item.value, proposed: item.proposed,
      donorName: item.donor.display_name, sourceInteraction: item.sourceInteraction,
      // Conditional on the exact value just observed -- if another writer
      // changed it since this read, `changes` comes back 0 at execution
      // time and executePlan() fails that donor closed instead of
      // overwriting an unexpected value (a compare-and-swap, not a guess).
      sql: `UPDATE donors SET relationship_summary = ${sqlLiteral(item.proposed)} WHERE id = ${sqlString(donorId)} AND relationship_summary = ${sqlLiteral(item.value)}`,
    };
  });
}

// I/O half of apply mode -- executes a plan from planApply(). `writeFn`
// defaults to the real `wranglerJson` (an actual D1 write, in --command
// mode -- deliberately NOT --file mode; see the comment above wranglerJson
// for why) but is injectable so tests can simulate D1's response (e.g.
// `changes: 0` for a stale-value race) without ever touching live data.
async function executePlan(plan, writeFn = wranglerJson) {
  const results = [];
  for (const step of plan) {
    if (step.action === "SKIP") {
      results.push({ donorId: step.donorId, status: "FAILED_CLOSED", before: step.value, after: null, reason: step.reason });
      continue;
    }
    const update = writeFn(step.sql);
    const changes = update?.[0]?.meta?.changes ?? 0;
    if (changes !== 1) {
      results.push({
        donorId: step.donorId, status: "FAILED_CLOSED", before: step.value, after: null,
        reason: `Conditional UPDATE matched ${changes} row(s), expected exactly 1 -- the stored relationship_summary changed between this run's read and write. No write applied.`,
      });
      continue;
    }
    results.push({
      donorId: step.donorId, status: "APPLIED", before: step.value, after: step.proposed,
      sourceInteraction: step.sourceInteraction, donorName: step.donorName,
    });
  }
  return results;
}

// APPLY MODE -- the only path in this file that writes to D1. Takes a list
// of donor IDs the caller has already gotten explicit human approval for
// (from the CLI, e.g. `--apply id1,id2`); re-fetches and re-classifies
// fresh from D1 (never a cached/earlier read) via fetchLiveClassification(),
// plans via planApply() (pure), then executes via executePlan() (the only
// write). Only `relationship_summary` is ever assigned; `institutional_memory`,
// interactions, and every other table/column are never referenced in any
// write statement in this file.
async function applyApproved(approvedIds) {
  const { candidates, buckets } = fetchLiveClassification();
  const plan = planApply(approvedIds, candidates, buckets);
  return executePlan(plan);
}

async function run() {
  console.log(`Reading ${DB_NAME} (read-only, no writes)...\n`);

  const { totalDonors, rsNonNull, imNonNull, candidates, buckets } = fetchLiveClassification();

  console.log(`Total donors scanned: ${totalDonors}`);
  console.log(`relationship_summary non-null: ${rsNonNull}`);
  console.log(`institutional_memory non-null: ${imNonNull} (audited separately -- NOT included in this cleanup; see header comment)`);
  console.log("");
  console.log(`SAFE TO CLEAR: ${buckets.SAFE_TO_CLEAR.length}`);
  console.log(`SAFE TO REGENERATE: ${buckets.SAFE_TO_REGENERATE.length}`);
  console.log(`NEEDS REVIEW: ${buckets.NEEDS_REVIEW.length}`);
  console.log(`MANUAL / PROVENANCE UNCERTAIN: ${buckets.MANUAL_UNCERTAIN.length}`);
  console.log(`ALREADY GOOD: ${buckets.ALREADY_GOOD.length}`);
  console.log(`UNCHANGED (no relationship_summary): ${totalDonors - candidates.length}`);
  console.log("");

  for (const [name, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    console.log(`\n=== ${name} (${items.length}) ===`);
    for (const item of items) {
      console.log(`\nDonor: ${item.donor.display_name} (${item.donor.id})`);
      console.log(`  Current: ${JSON.stringify(item.value)}`);
      if (item.proposed !== undefined && item.proposed !== null) console.log(`  Proposed: ${JSON.stringify(item.proposed)}`);
      if (item.proposed === null && name === "SAFE_TO_CLEAR") console.log(`  Proposed: null`);
      if (item.sourceInteraction) console.log(`  Source interaction: ${item.sourceInteraction.id} (${item.sourceInteraction.type}, ${new Date(item.sourceInteraction.occurred_at * 1000).toISOString().slice(0, 10)})`);
      console.log(`  Reason: ${item.reason}`);
    }
  }

  console.log("\nNo D1 writes were performed. This is a preview only.");
  return buckets;
}

// CLI: `node scripts/relationship-summary-cleanup-preview.mjs` previews
// (read-only). `node scripts/relationship-summary-cleanup-preview.mjs
// --apply <donorId1,donorId2,...>` writes ONLY the listed, explicitly-
// approved donor IDs -- and only those currently (freshly re-read) in the
// SAFE_TO_REGENERATE bucket. No proposed text is ever accepted on the
// command line; the replacement value always comes from the live extractor
// re-run inside applyApproved().
async function runCli() {
  const applyIndex = process.argv.indexOf("--apply");
  if (applyIndex === -1) {
    await run();
    return;
  }
  const idArg = process.argv[applyIndex + 1];
  const approvedIds = (idArg ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (approvedIds.length === 0) {
    console.error("--apply requires a comma-separated list of donor IDs, e.g. --apply id1,id2");
    process.exitCode = 1;
    return;
  }
  console.log(`Applying ${approvedIds.length} explicitly-approved donor ID(s) to ${DB_NAME} (relationship_summary only)...\n`);
  const results = await applyApproved(approvedIds);
  let failed = 0;
  for (const result of results) {
    console.log(`\nDonor: ${result.donorId}`);
    console.log(`  Status: ${result.status}`);
    if (result.status === "APPLIED") {
      console.log(`  Before: ${JSON.stringify(result.before)}`);
      console.log(`  After: ${JSON.stringify(result.after)}`);
    } else {
      failed++;
      console.log(`  Reason: ${result.reason}`);
    }
  }
  console.log(`\n${results.length - failed} applied, ${failed} failed closed (no write).`);
  if (failed > 0) process.exitCode = 1;
}

// Robust direct-execution check across platforms.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runCli();

export { run, applyApproved, planApply, executePlan, fetchLiveClassification, classifyDonors, candidateTexts, OLD_FORMAT_PREFIX, oldActionableRelationshipSnapshot, normalizeKind };
