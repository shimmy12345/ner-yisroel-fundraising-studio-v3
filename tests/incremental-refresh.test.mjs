import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { donationExportRange, isoDate, suggestedDonationRange } from "../lib/import/jl-refresh.ts";

const base = { Code: "JL-900", Name: "Fictional Family", "Total Due": "100", "Item Num": "GIFT", Desc: "Education support", Campaign: "ANNUAL", "Due Date": "2026-07-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };

const first = await buildJlDonationPreview([base], new Date("2026-08-03"));
const overlapping = await buildJlDonationPreview([base, { ...base, Desc: "New scholarship gift", "Due Date": "2026-08-01" }], new Date("2026-08-03"));
const household = [{ id: "donor-900", external_id: "JL-900" }];
const existing = [{ source_fingerprint: first.activities[0].fingerprint, paid_cents: 10000, balance_cents: 0, category: "completed_gift", source_snapshot: "{}" }];
const overlapMatch = matchJlDonationActivities(overlapping, household, existing);
assert.equal(overlapMatch.alreadyImported, 1, "the overlapping gift is skipped");
assert.equal(overlapMatch.newActivities.length, 1, "only the new gift is inserted");
assert.equal(new Set(overlapMatch.newActivities.map((row) => row.fingerprint)).size, 1);

const changedPledge = await buildJlDonationPreview([{ ...base, Paid: "40", "Balance Due": "60" }], new Date("2026-08-03"));
const pledgeMatch = matchJlDonationActivities(changedPledge, household, [{ ...existing[0], source_fingerprint: changedPledge.activities[0].fingerprint, paid_cents: 0, balance_cents: 10000, category: "open_pledge" }]);
assert.equal(pledgeMatch.newActivities.length, 0);
assert.equal(pledgeMatch.proposedUpdates.length, 1, "payment and balance changes update the stable fingerprint record");

const range = donationExportRange(overlapping.activities);
assert.deepEqual([isoDate(range.start), isoDate(range.end)], ["2026-07-15", "2026-08-01"]);
const suggested = suggestedDonationRange(range.end, new Date("2026-08-03T12:00:00Z"));
assert.deepEqual([isoDate(suggested.start), isoDate(suggested.end)], ["2026-07-26", "2026-08-03"]);

const route = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/onboarding/import/page.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0007_incremental_jl_refresh.sql", import.meta.url), "utf8");

assert.match(route, /const changedActivities = \[\.\.\.newActivities, \.\.\.proposedUpdates\]/);
assert.match(route, /ON CONFLICT\(owner_user_id, external_source, source_fingerprint\) DO UPDATE SET paid_cents/);
assert.match(route, /jl_refresh_state/);
assert.match(route, /historicalRecordsDeleted: 0/);
assert.match(route, /no database changes were made/i);
assert.doesNotMatch(route, /DELETE FROM (giving_activities|interactions|recommendations)/i);
assert.match(route, /decision\?\.action === "merge"/);
assert.match(route, /DELETE FROM donors WHERE id=\? AND owner_user_id=\? AND data_source='live' AND external_source='JL Solutions'/);
assert.match(previewRoute, /conflicts:/);
assert.match(previewRoute, /rejectedRows:/);
assert.match(page, /ORDER BY completed_at DESC, created_at DESC LIMIT 12/);
assert.match(experience, /Suggested donation export/);
assert.match(experience, /Recent JL refreshes/);
assert.match(experience, /Historical gifts were not deleted/);
assert.match(migration, /CREATE TABLE `jl_refresh_state`/);

process.stdout.write("Incremental JL refresh checks passed.\n");
