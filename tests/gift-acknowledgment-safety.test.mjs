import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Same convention as tests/monday-import-safety.test.mjs: the acknowledge
// route touches cloudflare:workers' env.DB, which only exists inside a
// Workers runtime, so its D1-dependent safety properties are verified
// against the route/schema source text rather than by executing it
// against a live D1 instance.

async function run() {
  const route = await readFile(new URL("../app/api/giving/acknowledge/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0026_gift_acknowledgments.sql", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const captureRoute = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
  const stagingReset = await readFile(new URL("../lib/operations/staging-reset.ts", import.meta.url), "utf8");

  // --- 6 & 7: a lightweight acknowledgment must never touch last-contact
  // or relationship-summary/institutional-memory machinery. The route's
  // only INSERT target is gift_acknowledgments; it must never reference
  // interactions, recommendations, or a donors UPDATE at all. ---
  const code = route.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\binteractions\b/i, "acknowledging a gift must never touch the interactions table");
  assert.doesNotMatch(code, /\brecommendations\b/i, "acknowledging a gift must never touch the recommendations table");
  assert.doesNotMatch(code, /UPDATE donors|relationship_summary|institutional_memory/i, "acknowledging a gift must never write donor narrative fields");
  assert.match(route, /INSERT INTO gift_acknowledgments/, "the route's only write must be to gift_acknowledgments");
  assert.doesNotMatch(code, /UPDATE gift_acknowledgments/, "acknowledgment must be append-only -- a status change is a new row, never an UPDATE, so earlier marks are never destroyed");

  // --- 5: every insert carries who marked it (user_id, the owner-scoped
  // actor) and when (created_at), and status is constrained to the three
  // documented values at the schema level, so an invalid status can never
  // be stored even if application validation were ever bypassed. ---
  assert.match(route, /INSERT INTO gift_acknowledgments \(id, donor_id, user_id, gift_source, gift_id, status, created_at, updated_at\)/);
  assert.match(schema, /status: text\("status", \{ enum: \["thank_you_sent", "thank_you_call", "no_acknowledgment_needed"\] \}\)/);
  assert.match(migration, /CHECK \(`status` IN \('thank_you_sent','thank_you_call','no_acknowledgment_needed'\)\)/);
  assert.match(migration, /CHECK \(`gift_source` IN \('giving_activity','gift'\)\)/);

  // --- Ownership: the referenced gift/giving activity must belong to the
  // authenticated owner's live records before anything is written. ---
  assert.match(route, /giving_activities WHERE id=\? AND owner_user_id=\? AND record_origin='live'/);
  assert.match(route, /gifts g JOIN donors d ON d\.id=g\.donor_id WHERE g\.id=\? AND d\.owner_user_id=\? AND d\.data_source='live'/);

  // --- 9: JL re-import idempotency. gift_acknowledgments is a wholly
  // separate table -- the JL import route's own UPDATE on giving_activities
  // never references it, so acknowledgment state survives every re-import
  // automatically, with no special-case needed in the import path at all. ---
  assert.doesNotMatch(importRoute, /gift_acknowledgments/, "the JL import route must never reference gift_acknowledgments -- that's what makes acknowledgment state re-import-safe by construction, not by a special case");

  // --- 8: a real interaction (the normal capture flow) is completely
  // unmodified by this feature -- it still writes interactions and, when
  // accepted, relationship_summary/institutional_memory, exactly as before. ---
  assert.match(captureRoute, /INSERT INTO interactions/);
  assert.match(captureRoute, /relationship_summary = \?, institutional_memory = \?/);
  assert.doesNotMatch(captureRoute, /gift_acknowledgments/, "the normal capture flow must never reference gift acknowledgment state");

  // --- new table is included in the independent-staging reset, so a
  // reset genuinely clears all fundraising data, not just some of it. ---
  assert.match(stagingReset, /"gift_acknowledgments"/);

  console.log("Gift acknowledgment safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
