import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function run() {
  const profile = await readFile(new URL("../lib/auth/profile.ts", import.meta.url), "utf8");
  const profileRoute = await readFile(new URL("../app/api/profile/route.ts", import.meta.url), "utf8");
  const shell = await readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
  const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const relationshipQueue = await readFile(new URL("../app/components/RelationshipQueueExperience.tsx", import.meta.url), "utf8");
  const live = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  const assistant = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  const donors = await readFile(new URL("../app/donors/page.tsx", import.meta.url), "utf8");
  const donor = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const unifiedTimeline = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
  const interactions = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const cleanup = await readFile(new URL("../app/api/sample-data/route.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0004_personalization_live_data.sql", import.meta.url), "utf8");
  const production = [shell, today, live, assistant, donors, donor, interactions].join("\n");

  assert.match(profile, /preferredFirstName/);
  assert.match(profileRoute, /organizationName/);
  assert.match(profileRoute, /timezone/);
  assert.match(shell, /profile\.fullName/);
  // The greeting must be computed from the actual time of day in the
  // user's stored timezone, not a hardcoded "Good morning" -- see
  // tests/local-time.test.mjs for the full boundary/timezone regression
  // coverage of timeOfDayGreeting itself.
  assert.match(today, /\{greeting\}, \{profile\.preferredFirstName\}/);
  assert.match(today, /timeOfDayGreeting\(now, profile\.timezone\)/);
  assert.doesNotMatch(today, /Good morning, \{profile\.preferredFirstName\}/, "the greeting must never be a hardcoded literal again");
  assert.match(today, /LocalDate timezone=\{profile\.timezone\}/);

  assert.match(live, /data_source = 'live'/);
  assert.match(live, /data_source = 'sample'/);
  assert.match(donors, /owner_user_id = \?/);
  assert.match(donor, /owner_user_id = \?/);
  assert.match(interactions, /owner_user_id = \?/);
  assert.match(assistant, /owner_user_id = \?/);
  assert.doesNotMatch(production, /Elena & David Chen|Marcus Williams|Sarah Mitchell|elena-chen/);

  assert.match(live, /recommendations r JOIN donors/);
  assert.match(live, /giving_activities ga JOIN donors/);
  // Contact-gap wording itself now lives in the shared recommendation
  // engine (lib/relationships/recommendation-candidates.ts), not
  // duplicated here -- see tests/recommendation-engine.test.mjs for the
  // wording coverage. This just proves live-data.ts is actually wired to
  // that shared engine rather than re-deriving its own text.
  assert.match(live, /buildRecommendationEvidence\(/);
  assert.match(live, /buildDonorRecommendation\(/);
  assert.match(today, /No activities or follow-ups need attention today/);
  assert.match(unifiedTimeline, /No relationship activity yet/);

  assert.match(migration, /owner_user_id/);
  assert.match(migration, /FOREIGN KEY/);
  assert.match(migration, /donors_owner_mode_name_idx/);
  assert.match(migration, /giving_activities_owner_date_idx/);
  assert.match(importRoute, /ownerUserId: userId/);
  assert.match(importRoute, /userCreatedContentPreserved: true/);
  assert.doesNotMatch(importRoute, /DELETE FROM interactions|DELETE FROM recommendations/);

  assert.match(cleanup, /mode: "preview"/);
  assert.match(cleanup, /backupConfirmed/);
  assert.match(cleanup, /REMOVE SAMPLE DATA/);
  assert.match(cleanup, /sample_cleanup_audits/);
  assert.match(cleanup, /await env\.DB\.batch/);
  assert.match(cleanup, /Only the workspace owner/);
  assert.match(cleanup, /data_source = 'sample'/);

  process.stdout.write("Personalization and live-data checks passed.\n");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
