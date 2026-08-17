import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nextGregorianRecurrence } from "../lib/calendar/gregorian-recurring-date.ts";
import { nextYahrtzeitOccurrence } from "../lib/calendar/hebrew-date.ts";

// Same convention as tests/gift-acknowledgment-safety.test.mjs and
// tests/monday-import-safety.test.mjs: the important-dates routes touch
// cloudflare:workers' env.DB, which only exists inside a Workers runtime,
// so their D1-dependent safety properties are verified against the route/
// schema source text rather than by executing them against a live D1
// instance.

async function run() {
  const createRoute = await readFile(new URL("../app/api/donors/[id]/important-dates/route.ts", import.meta.url), "utf8");
  const itemRoute = await readFile(new URL("../app/api/important-dates/[id]/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0028_important_dates.sql", import.meta.url), "utf8");
  const stagingReset = await readFile(new URL("../lib/operations/staging-reset.ts", import.meta.url), "utf8");

  // --- Birthday/anniversary CRUD must never touch interactions, giving,
  // pledges, or the recommendations table -- background family context,
  // never a logged contact, never an automatically-created reminder. ---
  for (const [name, source] of [["create route", createRoute], ["item route", itemRoute]]) {
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\binteractions\b/i, `${name} must never touch the interactions table`);
    assert.doesNotMatch(code, /\brecommendations\b/i, `${name} must never touch the recommendations table -- no automatic reminder is ever created`);
    assert.doesNotMatch(code, /\bgiving_activities\b|\bgifts\b/i, `${name} must never touch giving/pledge data`);
    assert.doesNotMatch(code, /UPDATE donors|relationship_summary|institutional_memory/i, `${name} must never write donor narrative fields`);
    // Structurally separate from yahrtzeits -- adding/editing/deleting a
    // birthday or anniversary must never read or write the yahrtzeits table.
    assert.doesNotMatch(code, /\byahrtzeits\b/i, `${name} must never touch the yahrtzeits table -- yahrtzeit data is untouched by this feature`);
  }

  // --- Every write is owner-scoped: the donor (create) or the important
  // date's own donor join (edit/delete) must belong to the authenticated
  // owner's live records before anything is written. ---
  assert.match(createRoute, /donors WHERE id=\? AND owner_user_id=\? AND data_source='live' AND archived_at IS NULL/, "create must verify the donor belongs to the authenticated owner before inserting");
  assert.match(itemRoute, /JOIN donors d ON d\.id = i\.donor_id/, "edit/delete must join through donors for ownership");
  assert.match(itemRoute, /d\.owner_user_id=\? AND d\.data_source='live'/, "edit/delete must verify owner_user_id and data_source scoping");
  assert.match(itemRoute, /i\.user_id=\?/, "edit/delete must also verify the important_dates row's own user_id");

  // --- Every create/update/delete writes an audit row in the same D1
  // batch as the mutation itself (matching yahrtzeit_changes' pattern),
  // so an audit entry can never be silently skipped by a partial failure. ---
  assert.match(createRoute, /INSERT INTO important_dates/);
  assert.match(createRoute, /INSERT INTO important_date_changes/);
  assert.match(createRoute, /env\.DB\.batch\(/, "create must write the row and its audit entry atomically");
  assert.match(itemRoute, /UPDATE important_dates SET/);
  assert.match(itemRoute, /INSERT INTO important_date_changes/);
  assert.match(itemRoute, /DELETE FROM important_dates WHERE id=\? AND user_id=\?/);
  const batchCount = (itemRoute.match(/env\.DB\.batch\(/g) ?? []).length;
  assert.equal(batchCount, 2, "both PATCH and DELETE must write their row change and audit entry atomically");

  // --- Schema: append-only audit action is constrained to the three
  // documented values, and important_date_id is deliberately not a foreign
  // key, so a deletion's audit row survives after the row it describes is
  // gone (same reasoning as yahrtzeit_changes). ---
  assert.match(schema, /action: text\("action", \{ enum: \["created", "updated", "deleted"\] \}\)/);
  assert.match(migration, /CHECK \(`action` IN \('created','updated','deleted'\)\)/);
  assert.match(migration, /CHECK \(`type` IN \('birthday','anniversary'\)\)/);
  assert.doesNotMatch(migration, /`important_date_id` text NOT NULL,\s*\n\s*FOREIGN KEY \(`important_date_id`\)/, "important_date_id must not be a foreign key");

  // --- new tables are included in the independent-staging reset, so a
  // reset genuinely clears all fundraising data, not just some of it. ---
  assert.match(stagingReset, /"important_dates"/);
  assert.match(stagingReset, /"important_date_changes"/);

  // --- Anniversary never stores a person name, even if one is sent --
  // the route/validation layer forces it to null, not just the UI. ---
  const validation = await readFile(new URL("../lib/important-dates/validation.ts", import.meta.url), "utf8");
  assert.match(validation, /type === "birthday" \? \(personNameRaw \|\| null\) : null/, "personName must be forced to null for anniversary at the validation layer, not merely omitted by the UI");

  // --- ImportantDatesManagement.tsx: occurrence/recurrence must be
  // computed exactly once per item, never repeatedly inside the sort
  // comparator (O(N log N)) and never a second time per rendered row. ---
  const management = await readFile(new URL("../app/donors/[id]/ImportantDatesManagement.tsx", import.meta.url), "utf8");
  const occurrenceCallSites = (management.match(/itemOccurrence\(/g) ?? []).length;
  assert.equal(occurrenceCallSites, 2, "itemOccurrence must appear exactly twice in the file -- its own definition, and the single call site inside .map() -- never inside the sort comparator, never a second time in ManagedDateRow");
  assert.match(management, /\.map\(\(item\) => \(\{ item, occurrence: itemOccurrence\(item, timezone\) \}\)\)/, "occurrence must be computed once per item via .map(), before sorting");
  assert.doesNotMatch(management, /\.sort\(\(a, b\) => \{[\s\S]{0,200}itemOccurrence/, "itemOccurrence must never be called inside the sort comparator");
  assert.doesNotMatch(management, /function ManagedDateRow[\s\S]{0,300}itemOccurrence\(/, "ManagedDateRow must receive occurrence as a prop, never recompute it itself");
  // Must recalculate whenever items/timezone actually change (useMemo's
  // dependency array) -- never a stale cache surviving past a later
  // add/edit/delete.
  assert.match(management, /useMemo\(\(\) => \{[\s\S]*?\}, \[items, timezone\]\)/, "occurrence/sort computation must be a useMemo keyed on items and timezone");

  // Hard-reload replaced with a scoped refresh (Part 4 UX cleanup, not a
  // resource-limit fix -- see the route's own render-cost comment).
  assert.doesNotMatch(management.replace(/^\s*\/\/.*$/gm, ""), /window\.location\.reload\(\)/, "the add/edit/delete flows must no longer force a full hard page reload");
  assert.match(management, /useRouter/, "must use next/navigation's useRouter for a scoped refresh");
  const refreshCallSites = (management.replace(/^\s*\/\/.*$/gm, "").match(/router\.refresh\(\)/g) ?? []).length;
  assert.equal(refreshCallSites, 3, "add, edit, and delete must each trigger exactly one scoped refresh (doneAdding/doneEditing/remove)");

  // --- Sort-order regression: a representative multi-item, multi-type
  // fixture (yahrtzeit + birthday + anniversary + one item with no valid
  // date) must sort into the same chronological order the component's own
  // comparator produces, using the real recurrence functions -- never a
  // reimplementation of the calendar math. ---
  const TIMEZONE = "America/New_York";
  const NOW = Math.floor(Date.parse("2026-08-13T12:00:00Z") / 1000);
  const fixtureItems = [
    { id: "far-yahrtzeit", kind: "yahrtzeit", hebrewMonth: "Kislev", hebrewDay: 10 }, // ~Nov 20, farthest out
    { id: "near-birthday", kind: "birthday", month: 8, day: 20, year: null }, // 7 days out
    { id: "mid-anniversary", kind: "anniversary", month: 9, day: 1, year: null }, // ~3 weeks out
    { id: "invalid-date", kind: "birthday", month: 13, day: 40, year: null }, // no valid occurrence -- must sort last
  ];
  function occurrenceEpoch(item) {
    try {
      const occurrence = item.kind === "yahrtzeit"
        ? nextYahrtzeitOccurrence(item.hebrewMonth, item.hebrewDay, TIMEZONE, NOW)
        : nextGregorianRecurrence(item.month, item.day, TIMEZONE, NOW);
      return occurrence.primary.gregorianEpoch;
    } catch {
      return null;
    }
  }
  // Mirrors the component's own useMemo exactly: compute once per item,
  // then sort by the cached epoch (missing/invalid dates sort last).
  const withOccurrence = fixtureItems.map((item) => ({ item, epoch: occurrenceEpoch(item) }));
  const sortedFixture = [...withOccurrence].sort((a, b) => (a.epoch ?? Number.MAX_SAFE_INTEGER) - (b.epoch ?? Number.MAX_SAFE_INTEGER));
  assert.deepEqual(sortedFixture.map((entry) => entry.item.id), ["near-birthday", "mid-anniversary", "far-yahrtzeit", "invalid-date"], "mixed yahrtzeit/birthday/anniversary items, plus one with no valid occurrence, must sort into chronological order with invalid dates last");

  console.log("Important-date safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
