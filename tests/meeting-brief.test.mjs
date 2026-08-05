import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMeetingBrief } from "../lib/relationships/meeting-brief-model.ts";

const donor = {
  id: "donor-a",
  displayName: "Adler Household",
  donorCode: "JL-100",
  externalId: "JL-100",
  lastName: "Example",
  primaryFirstName: "Ari",
  primaryName: "Ari",
  spouseName: "Miriam",
  email: "adler@example.test",
  phone: "555-1000",
  homePhone: null,
  address: ["10 Cedar Lane"],
};
const brief = buildMeetingBrief(
  donor,
  [
    { id: "gift-old", occurredAt: 1700000000, paidCents: 50000, balanceCents: 0, description: "Annual gift" },
    { id: "gift-recent", occurredAt: 1750000000, paidCents: 25000, balanceCents: 10000, description: "Scholarship fund" },
  ],
  [{ id: "interaction-a", type: "call", occurredAt: 1740000000, summary: "Discussed the recorded visit\nNo additional assumptions." }],
  [{ id: "reminder-a", action: "Send the recorded materials", reason: "Committed during the last call", dueAt: 1760000000 }],
);

assert.equal(brief.donor.id, "donor-a");
assert.equal(brief.lifetimePaidCents, 75000);
assert.equal(brief.recentGift?.id, "gift-recent");
assert.equal(brief.largestGift?.id, "gift-old");
assert.equal(brief.openPledgeCents, 10000);
assert.equal(brief.lastMeaningfulContact?.id, "interaction-a");
assert.equal(brief.discussionTopics.length, 3);
assert.equal(brief.followUpActions.length, 3);
assert.match(brief.discussionTopics.map((topic) => topic.detail).join(" "), /Scholarship fund/);
assert.doesNotMatch(JSON.stringify(brief), /hobby|interest|favorite|ask amount/i);

const empty = buildMeetingBrief(donor, [], [], []);
assert.equal(empty.recentGift, null);
assert.equal(empty.lastMeaningfulContact, null);
assert.equal(empty.discussionTopics.length, 3);
assert.match(empty.discussionTopics[0].detail, /No paid giving is recorded/);
assert.match(empty.discussionTopics[1].detail, /No prior interaction is recorded/);
assert.match(empty.discussionTopics[2].detail, /No open reminder or pledge commitment is recorded/);

const loader = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/donors/[id]/meeting-brief/page.tsx", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");

assert.match(loader, /WHERE id = \? AND owner_user_id = \? AND data_source = 'live'/);
assert.match(loader, /donor_id = \? AND owner_user_id = \? AND record_origin = 'live'/);
assert.match(loader, /i\.donor_id = \? AND i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(loader, /r\.donor_id = \? AND r\.user_id = \? AND d\.owner_user_id = \?/);
assert.doesNotMatch(loader, /data_source = 'sample'/);
assert.match(page, /Log Meeting Outcome/);
assert.match(page, /type=meeting/);
assert.match(donorPage, /Prepare for Meeting/);
assert.match(today, /Prepare for Meeting/);
assert.match(capturePage, /allowedKinds\.has\(requestedParams\.type/);

process.stdout.write("Meeting brief checks passed.\n");
