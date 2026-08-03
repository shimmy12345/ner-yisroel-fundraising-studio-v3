import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const completion = await readFile(new URL("../app/api/recommendations/[id]/complete/route.ts", import.meta.url), "utf8");
const completeButton = await readFile(new URL("../app/components/CompletePriorityButton.tsx", import.meta.url), "utf8");
const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");
const capture = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const relationshipRead = await readFile(new URL("../lib/relationships/read.ts", import.meta.url), "utf8");

for (const action of ["Log Interaction", "Schedule Meeting", "Find Donor", "Prepare for Meeting"]) assert.match(today, new RegExp(action));
assert.ok(today.indexOf("today-quick-actions") < today.indexOf("today-upcoming"));
assert.ok(today.indexOf("today-upcoming") < today.indexOf("<BriefExperience"));
assert.ok(today.indexOf("today-priorities") < today.indexOf("today-recent-activity"));
assert.match(today, /returnTo=%2F/);
assert.match(today, /priorities=all#priorities/);
assert.match(today, /showAll \? 50 : 8/);
assert.match(today, /Today’s Schedule/);
assert.match(today, /Future scheduled relationship activities/);
assert.match(today, /activity\.typeLabel/);
assert.match(today, /activity\.donorName/);
assert.match(today, /activity\.subject/);
assert.match(today, /Log Outcome/);

assert.match(liveData, /Overdue reminder/);
assert.match(liveData, /activityTypeLabel\(item\.type\).*today/);
assert.match(liveData, /gift needs acknowledgment/);
assert.match(liveData, /Open commitment/);
assert.match(liveData, /Contact gap/);
assert.match(liveData, /No interaction is recorded after the gift/);
assert.match(liveData, /i\.user_id = \? AND d\.owner_user_id = \? AND d\.data_source = 'live'/);
assert.match(liveData, /ga\.owner_user_id = \? AND ga\.record_origin = 'live'/);
assert.match(liveData, /capture-scheduled:%/);
assert.match(liveData, /i\.occurred_at > i\.created_at/);
assert.match(liveData, /scheduleBucket\(row\.source, row\.occurred_at, row\.created_at, now, timezone\) === "today"/);
assert.match(liveData, /scheduleBucket\(row\.source, row\.occurred_at, row\.created_at, now, timezone\) === "upcoming"/);

assert.match(completion, /id = \? AND user_id = \? AND status = 'open'/);
assert.match(completion, /owner_user_id = \? AND data_source = 'live'/);
assert.match(completeButton, /window\.location\.reload\(\)/);
assert.match(capturePage, /requestedParams\.returnTo === "\/"/);
assert.match(capture, /window\.location\.assign\(returnTo\)/);
assert.match(donorPage, /Scheduled and completed interactions/);
assert.match(donorPage, /isScheduledActivity\(item\.source, item\.occurred_at, item\.created_at\)/);
assert.match(relationshipRead, /source NOT LIKE 'capture-scheduled:%'.*source NOT LIKE 'cancelled:%'.*source NOT LIKE 'archived:%'.*occurred_at <= created_at/);

process.stdout.write("Today 2.0 checks passed.\n");
