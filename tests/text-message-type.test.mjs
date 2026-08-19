import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// Migration 0031 rehearsal, run against a real SQLite engine (matching the
// established convention in tests/production-baseline.test.mjs), plus
// source-text checks for the UI/copy/validation surfaces, matching
// tests/activity-editing.test.mjs's and tests/shared-activity-ux.test.mjs's
// established convention -- this codebase has no component-rendering
// harness, so behavior is verified by reading the real, committed source.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const allMigrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const migration0031 = "0031_interactions_text_type.sql";
assert.ok(allMigrations.includes(migration0031), "migration 0031 must exist on disk");
const preMigrations = allMigrations.filter((name) => name !== migration0031 && name <= "0030_shared_activities.sql");

function freshPre0031Database() {
  const database = new DatabaseSync(":memory:");
  for (const migration of preMigrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

function schemaObjects(database, tblName) {
  return database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? ORDER BY type, name").all(tblName);
}

async function run() {
  const database = freshPre0031Database();
  const now = Math.floor(Date.now() / 1000);

  // 0001_staging_sample_data.sql seeds its own rows into several tables
  // (including interactions), so counts here are relative to whatever that
  // migration already produced, not hardcoded absolutes.
  const seededInteractions = database.prepare("SELECT COUNT(*) c FROM interactions").get().c;
  const seededSharedActivities = database.prepare("SELECT COUNT(*) c FROM shared_activities").get().c;

  // Seed minimal, realistic fixture rows across every column this migration
  // must preserve, including a linked shared_activity_id/role pair, before
  // touching anything.
  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'owner@example.com', ${now}, ${now})`);
  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('d1', 'Donor One', ${now}, ${now}), ('d2', 'Donor Two', ${now}, ${now})`);
  database.exec(`INSERT INTO shared_activities (id, user_id, type, occurred_at, summary, source, recipient_count, created_at, updated_at)
    VALUES ('sa1', 'u1', 'email', ${now}, 'Pre-migration shared summary', 'manual', 2, ${now}, ${now})`);
  database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, shared_activity_id, role, created_at, updated_at) VALUES
    ('i1', 'd1', 'u1', 'call', ${now}, 'Ordinary single-donor call', 'manual', NULL, NULL, ${now}, ${now}),
    ('i2', 'd1', 'u1', 'email', ${now}, 'Recipient link one', 'manual', 'sa1', 'recipient', ${now}, ${now}),
    ('i3', 'd2', 'u1', 'email', ${now}, 'Recipient link two', 'manual', 'sa1', 'recipient', ${now}, ${now})`);

  const preInteractions = database.prepare("SELECT * FROM interactions ORDER BY id").all();
  const preSharedActivities = database.prepare("SELECT * FROM shared_activities ORDER BY id").all();
  const preInteractionSchema = schemaObjects(database, "interactions");
  assert.equal(preInteractions.length, seededInteractions + 3);
  assert.equal(preSharedActivities.length, seededSharedActivities + 1);

  // --- 1/2: apply 0031, then prove every pre-existing row survives byte-for-byte ---
  database.exec(fs.readFileSync(path.join(migrationDirectory, migration0031), "utf8"));

  const postInteractions = database.prepare("SELECT * FROM interactions ORDER BY id").all();
  const postSharedActivities = database.prepare("SELECT * FROM shared_activities ORDER BY id").all();
  assert.deepEqual(postInteractions, preInteractions, "every interactions row must survive 0031 byte-for-byte (interactions is not even rebuilt by this migration)");
  assert.deepEqual(postSharedActivities, preSharedActivities, "every shared_activities row must survive 0031 byte-for-byte across the table rebuild");

  // --- 7: interactions itself must be completely untouched -- confirmed by
  // more than row survival: interactions is never dropped/rebuilt at all by
  // 0031 (there is no CHECK constraint on it to widen), so its own schema
  // objects (table DDL + every index) must be byte-for-byte identical
  // before and after. ---
  assert.deepEqual(schemaObjects(database, "interactions"), preInteractionSchema, "interactions' own schema objects must be completely unchanged by 0031 -- this migration never touches that table");
  const interactionIndexNames = preInteractionSchema.filter((o) => o.type === "index").map((o) => o.name);
  assert.ok(interactionIndexNames.includes("interactions_donor_date_idx"));
  assert.ok(interactionIndexNames.includes("interactions_shared_activity_idx"));
  assert.ok(interactionIndexNames.includes("interactions_shared_activity_donor_uidx"));

  // --- 8: shared_activities' own indexes survive the rebuild ---
  const sharedActivitiesIndexes = schemaObjects(database, "shared_activities").filter((o) => o.type === "index").map((o) => o.name);
  assert.ok(sharedActivitiesIndexes.includes("shared_activities_user_date_idx"));

  // --- 3: "text" is now accepted by shared_activities' CHECK constraint ---
  assert.doesNotThrow(() => database.exec(`INSERT INTO shared_activities (id, user_id, type, occurred_at, summary, source, recipient_count, created_at, updated_at)
    VALUES ('sa-text', 'u1', 'text', ${now}, 'A text message summary', 'manual', 1, ${now}, ${now})`));

  // --- 4: "text" is accepted by interactions too (no CHECK exists there at
  // all, so this simply must not throw -- the real enforcement for this
  // table is application-level, exercised by the source-text checks below) ---
  assert.doesNotThrow(() => database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
    VALUES ('i-text', 'd1', 'u1', 'text', ${now}, 'A text message summary', 'manual', ${now}, ${now})`));

  // --- 5: every previously-valid type is still accepted by shared_activities ---
  for (const type of ["call", "email", "meeting", "visit", "note", "personal", "gift"]) {
    assert.doesNotThrow(() => database.exec(`INSERT INTO shared_activities (id, user_id, type, occurred_at, summary, source, recipient_count, created_at, updated_at)
      VALUES ('sa-${type}', 'u1', '${type}', ${now}, 'still valid', 'manual', 1, ${now}, ${now})`), `${type} must remain accepted after widening the CHECK constraint`);
  }

  // --- 6: a genuinely invalid type is still rejected by shared_activities' CHECK ---
  assert.throws(() => database.exec(`INSERT INTO shared_activities (id, user_id, type, occurred_at, summary, source, recipient_count, created_at, updated_at)
    VALUES ('sa-bogus', 'u1', 'bogus', ${now}, 'invalid', 'manual', 1, ${now}, ${now})`), /CHECK constraint failed/, "the widened CHECK constraint must still reject a value outside the allowed set");

  // --- 9: shared_activity_id/role on the pre-existing linked rows are intact ---
  const linked = database.prepare("SELECT id, donor_id, shared_activity_id, role FROM interactions WHERE shared_activity_id = 'sa1' ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(linked, [
    { id: "i2", donor_id: "d1", shared_activity_id: "sa1", role: "recipient" },
    { id: "i3", donor_id: "d2", shared_activity_id: "sa1", role: "recipient" },
  ]);

  // --- 10: the partial unique index still prevents double-linking the same donor to the same activity ---
  assert.throws(() => database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, shared_activity_id, role, created_at, updated_at)
    VALUES ('i-dup', 'd1', 'u1', 'email', ${now}, 'duplicate link attempt', 'manual', 'sa1', 'recipient', ${now}, ${now})`), /UNIQUE constraint failed/, "donor d1 is already linked to sa1 -- a second link must still be rejected after 0031");
  // A donor NOT already linked to this activity must still be linkable (the
  // constraint is per-activity, not a blanket "no more links" rule).
  assert.doesNotThrow(() => database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('d3', 'Donor Three', ${now}, ${now})`));
  assert.doesNotThrow(() => database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, shared_activity_id, role, created_at, updated_at)
    VALUES ('i-new-link', 'd3', 'u1', 'email', ${now}, 'a genuinely new link', 'manual', 'sa1', 'recipient', ${now}, ${now})`));

  database.close();
  process.stdout.write("Migration 0031 rehearsal (real SQLite) passed.\n");
}

await run();

// --- Scoring semantics: shared Text Message role determines
// broadcast-vs-substantive, exactly like every other type (no per-type
// branch exists or should exist). Proven by executing the REAL production
// WHERE-clause fragment (asserted verbatim below to guard against silent
// drift) against a fully-migrated database seeded with type='text' rows. ---
async function runScoringSemantics() {
  const liveDataSource = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  const substantiveClause = "AND (role IS NULL OR role != 'recipient')";
  assert.ok(liveDataSource.includes(substantiveClause), "the substantive-contact query's role exclusion clause must exist verbatim -- if this fails, the clause was edited and this test's own query below must be updated to match");

  const database = new DatabaseSync(":memory:");
  for (const migration of allMigrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('su1', 'scoring@example.com', ${now}, ${now})`);
  database.exec(`INSERT INTO donors (id, display_name, owner_user_id, data_source, created_at, updated_at) VALUES ('sd1', 'Scoring Donor', 'su1', 'live', ${now}, ${now})`);
  database.exec(`INSERT INTO shared_activities (id, user_id, type, occurred_at, summary, source, recipient_count, created_at, updated_at)
    VALUES ('ssa1', 'su1', 'text', ${now - 86400}, 'Broadcast text update', 'manual', 1, ${now}, ${now})`);

  function substantiveContactAt() {
    const row = database.prepare(`SELECT MAX(occurred_at) AS value FROM interactions WHERE user_id = 'su1' AND donor_id = 'sd1' AND occurred_at <= ${now}
      AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'
      AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))
      ${substantiveClause}`).get();
    return row.value;
  }
  function lastContactAt() {
    const row = database.prepare(`SELECT MAX(occurred_at) AS value FROM interactions WHERE user_id = 'su1' AND donor_id = 'sd1' AND occurred_at <= ${now}
      AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'
      AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))`).get();
    return row.value;
  }

  // A shared Text Message logged with role='recipient' updates Last Contact...
  database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, shared_activity_id, role, created_at, updated_at)
    VALUES ('si-recipient', 'sd1', 'su1', 'text', ${now - 86400}, 'Broadcast text update', 'capture-completed:manual', 'ssa1', 'recipient', ${now - 86400}, ${now - 86400})`);
  assert.equal(lastContactAt(), now - 86400, "a shared Text Message recipient touch must update Last Contact");
  assert.equal(substantiveContactAt(), null, "a shared Text Message recipient touch must NOT count toward lastSubstantiveContactAt -- it must not suppress reconnect_contact_gap");

  // ...and a shared Text Message logged with role='participant' counts as
  // substantive, exactly like any ordinary interaction.
  database.exec(`INSERT INTO donors (id, display_name, owner_user_id, data_source, created_at, updated_at) VALUES ('sd2', 'Scoring Donor Two', 'su1', 'live', ${now}, ${now})`);
  database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, shared_activity_id, role, created_at, updated_at)
    VALUES ('si-participant', 'sd2', 'su1', 'text', ${now - 3600}, 'Two-way text exchange', 'capture-completed:manual', 'ssa1', 'participant', ${now - 3600}, ${now - 3600})`);
  const participantRow = database.prepare(`SELECT MAX(occurred_at) AS value FROM interactions WHERE user_id = 'su1' AND donor_id = 'sd2' AND occurred_at <= ${now}
    AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'
    AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))
    ${substantiveClause}`).get();
  assert.equal(participantRow.value, now - 3600, "a shared Text Message participant touch must count toward lastSubstantiveContactAt, same as any other substantive interaction");

  database.close();
  process.stdout.write("Text Message role/scoring semantics (real SQLite) passed.\n");
}

await runScoringSemantics();

// --- Source-level checks: UI, copy, validation, scoring semantics ---

const interactionLib = await readFile(new URL("../lib/capture/interaction.ts", import.meta.url), "utf8");
const interactionsRoute = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
const interactionIdRoute = await readFile(new URL("../app/api/interactions/[id]/route.ts", import.meta.url), "utf8");
const sharedRoute = await readFile(new URL("../app/api/interactions/shared/route.ts", import.meta.url), "utf8");
const captureExperience = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const timelineExperience = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const meetingBriefPage = await readFile(new URL("../app/donors/[id]/meeting-brief/page.tsx", import.meta.url), "utf8");
const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const outcomeExperience = await readFile(new URL("../app/interactions/[id]/outcome/OutcomeExperience.tsx", import.meta.url), "utf8");

// 7/8/9: single-donor Text Message create/edit works, and the friendly label exists.
assert.match(interactionLib, /export type InteractionKind = "call" \| "email" \| "meeting" \| "visit" \| "note" \| "personal" \| "text";/, "InteractionKind must include text");
assert.match(interactionLib, /text: "Text Message"/, "the friendly label for the text channel must be 'Text Message', never the raw enum value");
assert.match(interactionsRoute, /"personal", "text"\]/, "the create route's validation set must accept text");
assert.match(interactionIdRoute, /"personal", "text"\]/, "the edit route's validation set must accept text");

// 10/11/12: multi-donor Text Message appears in the picker, defaults to
// recipient, and the role picker (already existing, unchanged) still lets
// the fundraiser choose participant explicitly.
assert.match(captureExperience, /\{ value: "text", icon: "[^"]+" \}/, "Text Message must be a real option in the shared type picker (same kinds array as single-donor)");
assert.match(captureExperience, /text: "recipient"/, "Text Message must default to recipient in ROLE_DEFAULT_BY_KIND");
assert.match(captureExperience, /setRoleOverride\("participant"\)/, "the existing explicit participant override must remain available for every type, including text");

// 13: the unified timeline label must never render the raw "text" enum value
// -- it previously interpolated activity.type directly into the event-type
// badge (a pre-existing issue for every type, not introduced by Text
// Message, but this task explicitly forbids shipping it for "text").
assert.match(timelineExperience, /interactionKindLabel\(activity\.type as InteractionKind\)/, "the timeline event-type badge must render the friendly label, not the raw type value");

// 14: the Today/homepage workspace queue's own duplicate label map (found
// during audit -- separate from KIND_LABELS in lib/capture/interaction.ts)
// must also know "text", or a scheduled Text Message would fall back to the
// generic "Activity" label instead of "Text Message".
assert.match(liveData, /text: "Text Message"/, "the workspace queue's activityTypeLabel map must include text");
// The outcome/follow-up page's own label helper must route through the
// canonical interactionKindLabel rather than a second capitalize-only
// fallback, so it says "Text Message" and not just "Text".
assert.match(outcomeExperience, /interactionKindLabel\(type as InteractionKind\)/, "the outcome page's typeLabel must use the canonical friendly label");

// 15/16: Meeting Brief and Assistant never expose the raw "text" enum value where a label belongs.
assert.doesNotMatch(meetingBriefPage, />text</, "Meeting Brief must never render the raw enum value as visible text");
assert.match(assistantRoute, /shared_activity_summary \?\? latest\.summary/, "Assistant must keep using the existing summary-preference logic, unaffected by adding a new type");

// 17: no automatic reminder/recommendation creation for a shared Text Message
// -- this is the existing, unmodified shared-route contract; a new type must
// not introduce a new code path around it.
assert.doesNotMatch(sharedRoute, /recommendations/i, "the shared-activity route must still never reference the recommendations table, regardless of type");

process.stdout.write("Text Message interaction type checks passed.\n");
