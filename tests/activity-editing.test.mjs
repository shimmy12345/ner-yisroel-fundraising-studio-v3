import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isArchivedActivity, isCancelledActivity } from "../lib/workspace/scheduled-activity.ts";

const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");
const capture = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const autocomplete = await readFile(new URL("../app/capture/DonorAutocomplete.tsx", import.meta.url), "utf8");
const directory = await readFile(new URL("../app/donors/page.tsx", import.meta.url), "utf8");
const directoryExperience = await readFile(new URL("../app/donors/DonorDirectoryExperience.tsx", import.meta.url), "utf8");
const directorySearch = await readFile(new URL("../app/donors/DonorDirectorySearch.tsx", import.meta.url), "utf8");
const editPage = await readFile(new URL("../app/interactions/[id]/edit/page.tsx", import.meta.url), "utf8");
const activityRoute = await readFile(new URL("../app/api/interactions/[id]/route.ts", import.meta.url), "utf8");
const activityActions = await readFile(new URL("../app/components/ActivityActions.tsx", import.meta.url), "utf8");
const todayData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const unifiedTimeline = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");

assert.match(capturePage, /const initialDonorId = requested && donors\.results\.some/);
assert.doesNotMatch(capturePage, /donors\.results\[0\]\?\.id/);
assert.match(capture, /method: initialActivity \? "PATCH" : "POST"/);
assert.match(capture, /initialActivity\?\.donorId/);
assert.match(capture, /Save changes/);

assert.match(autocomplete, /useState\(-1\)/);
assert.match(autocomplete, /activeIndex >= 0/);
assert.match(directory, /<DonorDirectoryExperience/);
assert.match(directoryExperience, /<DonorDirectorySearch/);
assert.match(directorySearch, /<DonorAutocomplete/);
assert.match(directorySearch, /window\.location\.assign/);
for (const field of ["lastName", "name", "spouse", "code", "email", "phone"]) assert.match(await readFile(new URL("../lib/relationships/donor-search.ts", import.meta.url), "utf8"), new RegExp(`donor\\.${field}`));

assert.match(editPage, /initialActivity=\{/);
assert.match(editPage, /activity\.donor_id/);
assert.match(activityRoute, /export async function PATCH/);
assert.match(activityRoute, /export async function DELETE/);
assert.match(activityRoute, /d\.owner_user_id = \?/);
assert.match(activityRoute, /cancelled:/);
assert.match(activityRoute, /archived:/);
assert.doesNotMatch(activityRoute, /DELETE FROM interactions/);
assert.match(activityRoute, /DELETE FROM recommendations/);
assert.match(activityActions, /window\.confirm/);
assert.match(activityActions, /window\.location\.reload\(\)/);
assert.match(unifiedTimeline, /ActivityActions/);
assert.match(unifiedTimeline, /Cancelled ·/);
assert.match(todayData, /source NOT LIKE 'cancelled:%'/);
assert.match(todayData, /source NOT LIKE 'archived:%'/);
assert.equal(isCancelledActivity("cancelled:capture-scheduled:call"), true);
assert.equal(isArchivedActivity("archived:capture:email"), true);

process.stdout.write("Activity editing and donor search checks passed.\n");
