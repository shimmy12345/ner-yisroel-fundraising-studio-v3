import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview, classifyJlDonation } from "../lib/import/jl-donations.ts";
import { buildUnifiedTimeline } from "../lib/relationships/unified-timeline.ts";

// Live incident: after import, donor timelines showed every JL donation
// generically as "Gift" with no way to see the Campaign column from the
// source export. Audited the actual staging data first (read-only): every
// one of 5,171 already-imported JL gifts already has source_campaign
// populated in giving_activities -- nothing was discarded, and no schema
// change or backfill is needed. The bug is that the donor-timeline query
// (lib/relationships/giving.ts's DONOR_GIVING_SQL) never selected
// source_campaign in the first place, so the UI's title fallback
// (description || item_type || "Gift") never had campaign to fall back to
// -- and a JL compact-format export leaves description/item_type empty on
// every row, so it always fell through to the generic label.

const base = { "Total Due": "100", "Item Num": "GIFT", Desc: "", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };
const now = new Date("2026-08-10");

async function run() {
  // ---- 1. A donation with Campaign preserves it, in the canonical field
  // (source_campaign / sourceCampaign) and unmutated in the source
  // snapshot. ---
  const withCampaign = { ...base, Code: "JL-1", "Due Date": "2025-06-01", Campaign: "Annual Dinner" };
  const classified = classifyJlDonation(withCampaign, now);
  assert.equal(classified.sourceCampaign, "Annual Dinner", "Campaign must be preserved into the canonical sourceCampaign field");
  const previewWithCampaign = await buildJlDonationPreview([withCampaign], now);
  assert.equal(previewWithCampaign.activities[0].sourceCampaign, "Annual Dinner");
  assert.equal(previewWithCampaign.activities[0].sourceValues.Campaign, "Annual Dinner", "the raw source_snapshot value must remain exactly what was uploaded");
  assert.equal(previewWithCampaign.activities[0].category, "completed_gift", "campaign handling must never change the transaction type/category");

  // ---- 2. A donation without Campaign still imports normally -- blank
  // Campaign is not a validation failure. ----
  const withoutCampaign = { ...base, Code: "JL-2", "Due Date": "2025-06-02" };
  delete withoutCampaign.Campaign;
  const withoutClassified = classifyJlDonation(withoutCampaign, now);
  assert.equal(withoutClassified.sourceCampaign, "", "a missing Campaign column must classify as an empty string, never block import");
  assert.equal(withoutClassified.category, "completed_gift");
  const previewWithout = await buildJlDonationPreview([withoutCampaign], now);
  assert.equal(previewWithout.activities[0].category, "completed_gift", "the row must still import with no Campaign present");

  // ---- 3. Two otherwise-identical donations that differ only by Campaign
  // must not be collapsed into one duplicate -- Campaign is part of the
  // duplicate fingerprint. Amounts, dates, and household matching must be
  // unaffected by the campaign difference. ----
  const campaignA = { ...base, Code: "JL-3", "Due Date": "2025-07-01", Amount: "250.00", Paid: "250.00", Campaign: "Chai Campaign" };
  const campaignB = { ...campaignA, Campaign: "Building Fund" };
  const twoCampaignsPreview = await buildJlDonationPreview([campaignA, campaignB], now);
  const [activityA, activityB] = twoCampaignsPreview.activities;
  assert.notEqual(activityA.fingerprint, activityB.fingerprint, "rows differing only by Campaign must never share a fingerprint");
  assert.equal(activityA.duplicateStatus, null, "different campaigns must not be flagged as a possible in-file duplicate");
  assert.equal(activityB.duplicateStatus, null);
  assert.equal(activityA.externalHouseholdId, activityB.externalHouseholdId, "campaign must not affect household matching");
  assert.equal(activityA.activityDate, activityB.activityDate, "campaign must not affect the activity date");
  assert.equal(activityA.committedCents, activityB.committedCents, "campaign must not affect amounts");
  assert.equal(activityA.sourceCampaign, "Chai Campaign");
  assert.equal(activityB.sourceCampaign, "Building Fund");

  // A genuine duplicate (identical content, including Campaign) is still
  // correctly detected as one -- confirming the fingerprint's sensitivity
  // to Campaign didn't come at the cost of normal duplicate detection.
  const trueDuplicatePreview = await buildJlDonationPreview([campaignA, { ...campaignA }], now);
  assert.equal(trueDuplicatePreview.activities[0].duplicateStatus, "possible_duplicate");
  assert.equal(trueDuplicatePreview.activities[1].duplicateStatus, "possible_duplicate");

  // ---- 4. The timeline data pipeline carries source_campaign through
  // unchanged (buildUnifiedTimeline never strips or renames it), and the
  // display code actually uses it. ----
  const givingWithCampaign = { id: "g1", donor_id: "d1", external_source: "JL Solutions", activity_date: 1750000000, committed_cents: 5000, paid_cents: 5000, balance_cents: 0, item_type: "", description: "", source_campaign: "Chai Campaign", category: "completed_gift", workspace_status: "active", private_note: null, updated_at: 0 };
  const timeline = buildUnifiedTimeline({ giving: [givingWithCampaign], legacyGifts: [], payments: [], interactions: [], reminders: [], now: 0 });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "giving");
  assert.equal(timeline[0].giving.source_campaign, "Chai Campaign", "source_campaign must survive buildUnifiedTimeline unchanged");

  const givingSql = await readFile(new URL("../lib/relationships/giving.ts", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const timelineComponent = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
  const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");

  assert.match(givingSql, /source_campaign/, "the donor-timeline query must select source_campaign -- this was the actual root cause, not a display bug alone");
  assert.match(pageSource, /source_campaign.*category.*workspace_status.*FROM giving_activities WHERE donor_id = \? AND record_origin = 'sample'/, "the demo-mode query must also select source_campaign, not only the live query");
  assert.match(pageSource, /pledge\.source_campaign AS pledge_campaign/, "a payment's linked pledge campaign must also be available for display");
  assert.match(timelineComponent, /activity\.description \|\| activity\.item_type \|\| activity\.source_campaign \|\|/, "campaign must be used as a title fallback -- transaction type stays in the separate event-type badge");
  assert.match(timelineComponent, /activity\.source_campaign && <span className="event-campaign">/, "campaign must be shown as its own element, not only when it happens to win the title fallback");
  assert.match(timelineComponent, /item\.payment\.pledge_campaign && <span className="event-campaign">/, "a pledge payment's campaign must also be visible without opening raw import data");
  assert.match(meetingBrief, /source_campaign/, "the meeting-brief gift summary must also be able to show campaign instead of a bare description/item type fallback");

  // Blank campaign must retain the plain "Gift"/"Pledge" label -- no empty
  // placeholder. The fallback chain short-circuits on the first truthy
  // value, so an empty source_campaign ("" or null) simply falls through;
  // there is no branch that renders an empty campaign badge.
  assert.doesNotMatch(timelineComponent, /<span className="event-campaign">\{activity\.source_campaign \|\| ""\}<\/span>/, "an empty campaign must never render an empty badge");

  process.stdout.write("Campaign preservation and display checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
