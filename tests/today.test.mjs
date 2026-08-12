import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const queueExperience = await readFile(new URL("../app/components/RelationshipQueueExperience.tsx", import.meta.url), "utf8");
const completion = await readFile(new URL("../app/api/recommendations/[id]/complete/route.ts", import.meta.url), "utf8");
const completeButton = await readFile(new URL("../app/components/CompletePriorityButton.tsx", import.meta.url), "utf8");
const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");
const capture = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const unifiedTimeline = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const relationshipRead = await readFile(new URL("../lib/relationships/read.ts", import.meta.url), "utf8");
const appShell = await readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
const briefExperience = await readFile(new URL("../app/components/BriefExperience.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const recommendationCandidates = await readFile(new URL("../lib/relationships/recommendation-candidates.ts", import.meta.url), "utf8");

for (const action of ["Search Donor", "Import JL Export", "Add Interaction", "Create Reminder", "Workspace Health"]) assert.match(today, new RegExp(action));
for (const section of ["Today's Agenda", "Coming Up", "Quick Actions", "Morning Brief"]) assert.match(today, new RegExp(section));
assert.ok(today.indexOf("Morning Brief") < today.indexOf("Quick Actions"), "Morning Brief must be visible near the top, ahead of Quick Actions");
assert.ok(today.indexOf("Quick Actions") < today.indexOf("Today's Agenda"), "Quick Actions must be visible near the top, ahead of the detailed agenda");
assert.ok(today.indexOf("Today's Agenda") < today.indexOf("Coming Up"));
assert.match(today, /returnTo=%2F/);
assert.match(queueExperience, /priorities=all#\$\{queueAnchor\}/);
assert.match(today, /showAll \? 50 : 10/);
assert.match(today, /No activities or follow-ups need attention today/);
assert.match(today, /agendaIsEmpty.*comingIsEmpty/);
assert.match(today, /Birthdays and anniversaries will appear here in a future update/);
assert.match(today, /activity\.typeLabel/);
assert.match(today, /activity\.donorName/);
assert.match(today, /activity\.subject/);
assert.match(today, /Log Outcome/);
for (const group of ["Overdue", "Due today", "This Week", "Later"]) assert.match(queueExperience, new RegExp(group));
assert.match(queueExperience, /scope === "agenda"/);
assert.match(queueExperience, /expanded \? 5/);
assert.doesNotMatch(today, /ACT NOW|PLAN AHEAD|REFERENCE|LIVE WORKSPACE/);
for (const behavior of ["completedToday", "markComplete", "Read Again", "Dismiss for today", "localStorage"]) assert.match(briefExperience, new RegExp(behavior));
assert.match(briefExperience, /speech\.message === "Full brief finished\."/);
assert.match(styles, /today-command-grid/);
assert.match(styles, /grid-template-columns:minmax\(0,1\.35fr\)/);
assert.match(styles, /@media \(max-width:760px\)[\s\S]*today-actions-section \.today-quick-actions \{ grid-template-columns:1fr 1fr/);

assert.match(liveData, /Overdue follow-up/);
assert.match(liveData, /Open commitment/);
assert.match(liveData, /Contact gap/);
// Recent-gift/open-commitment/contact-gap wording itself now comes from
// the shared recommendation engine (see tests/recommendation-engine.test.mjs
// for the wording coverage), not duplicated in live-data.ts.
assert.match(recommendationCandidates, /has not been marked acknowledged yet/);
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
assert.doesNotMatch(completeButton, /window\.location\.reload\(\)/);
assert.match(completeButton, /onOptimisticComplete/);
assert.match(queueExperience, /completeOptimistically/);
assert.match(queueExperience, /restoreFailedCompletion/);
assert.match(appShell, /active === "import"/);
assert.match(appShell, /href="\/onboarding\/import"/);
assert.match(capturePage, /requestedParams\.returnTo === "\/"/);
assert.match(capture, /window\.location\.assign\(returnTo\)/);
assert.match(donorPage, /One chronological story/);
assert.match(donorPage, /isScheduledActivity\(item\.source, item\.occurred_at, item\.created_at\)/);
assert.match(unifiedTimeline, /scheduled/i);
assert.match(relationshipRead, /source LIKE 'capture-completed:%'/);
assert.match(relationshipRead, /source NOT LIKE 'capture-scheduled:%'.*occurred_at <= created_at/);

process.stdout.write("Today 2.0 checks passed.\n");
