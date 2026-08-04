import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const completion = await readFile(new URL("../app/api/recommendations/[id]/complete/route.ts", import.meta.url), "utf8");
const completeButton = await readFile(new URL("../app/components/CompletePriorityButton.tsx", import.meta.url), "utf8");
const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");
const capture = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const unifiedTimeline = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const relationshipRead = await readFile(new URL("../lib/relationships/read.ts", import.meta.url), "utf8");

for (const action of ["Log Interaction", "Schedule Meeting", "Find Donor", "Prepare for Meeting"]) assert.match(today, new RegExp(action));
assert.ok(today.indexOf("today-quick-actions") < today.indexOf("today-morning-brief"));
assert.ok(today.indexOf("today-morning-brief\" aria-labelledby") < today.indexOf("className=\"relationship-queue\""));
assert.ok(today.indexOf("className=\"relationship-queue\"") < today.indexOf("today-upcoming today-schedule"));
assert.ok(today.indexOf("<BriefExperience") < today.indexOf("today-recent-activity"));
assert.match(today, /returnTo=%2F/);
assert.match(today, /priorities=all#relationship-queue/);
assert.match(today, /showAll \? 50 : 10/);
assert.match(today, /Today's Schedule/);
assert.match(today, /Upcoming scheduled activities/);
assert.match(today, /activity\.typeLabel/);
assert.match(today, /activity\.donorName/);
assert.match(today, /activity\.subject/);
assert.match(today, /Log Outcome/);
for (const section of ["Morning Brief", "Relationship Queue", "Recently viewed donors", "Recently updated relationships"]) assert.match(today, new RegExp(section, "i"));
for (const group of ["Overdue", "Today", "This Week", "Upcoming"]) assert.match(today, new RegExp(group));

assert.match(liveData, /Overdue follow-up/);
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
assert.match(liveData, /relationship_queue_dismissals/);
assert.match(liveData, /donor_views v JOIN donors/);
assert.match(liveData, /d\.archived_at IS NULL/);

assert.match(completion, /id = \? AND user_id = \? AND status = 'open'/);
assert.match(completion, /owner_user_id = \? AND data_source = 'live'/);
assert.match(completeButton, /window\.location\.reload\(\)/);
assert.match(capturePage, /requestedParams\.returnTo === "\/"/);
assert.match(capture, /window\.location\.assign\(returnTo\)/);
assert.match(donorPage, /One chronological story/);
assert.match(donorPage, /isScheduledActivity\(item\.source, item\.occurred_at, item\.created_at\)/);
assert.match(unifiedTimeline, /scheduled/i);
assert.match(relationshipRead, /source LIKE 'capture-completed:%'/);
assert.match(relationshipRead, /source NOT LIKE 'capture-scheduled:%'.*occurred_at <= created_at/);

process.stdout.write("Today 2.0 checks passed.\n");
