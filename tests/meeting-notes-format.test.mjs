import assert from "node:assert/strict";
import { buildMeetingNotesSummaryText } from "../lib/meeting-notes/format.ts";

const full = buildMeetingNotesSummaryText({
  summary: "Discussed the building fund.",
  donorInterests: "Building fund\nKollel sponsorship",
  fundraisingOpportunities: "Naming opportunity",
  confirmedCommitments: "Will send $500",
  possibleCommitments: "Might give more next year",
  relationshipContext: "Daughter's wedding in spring",
});
assert.match(full, /Meeting Summary:\nDiscussed the building fund\./);
assert.match(full, /Donor Interests:\nBuilding fund\nKollel sponsorship/);
assert.match(full, /Fundraising Opportunities:\nNaming opportunity/);
assert.match(full, /Confirmed Commitments:\nWill send \$500/);
assert.match(full, /Possible Commitments \/ Discussions:\nMight give more next year/);
assert.match(full, /Relationship Context:\nDaughter's wedding in spring/);

// A quick manual note -- only a summary typed, nothing else organized --
// must save as a clean single paragraph, never a form full of empty
// section headers.
const manualOnly = buildMeetingNotesSummaryText({
  summary: "Quick call, donor is traveling, will follow up next week.",
  donorInterests: "",
  fundraisingOpportunities: "   ",
  confirmedCommitments: "",
  possibleCommitments: "",
  relationshipContext: "",
});
assert.equal(manualOnly, "Meeting Summary:\nQuick call, donor is traveling, will follow up next week.");
assert.doesNotMatch(manualOnly, /Donor Interests:/);
assert.doesNotMatch(manualOnly, /Fundraising Opportunities:/);

// Every section empty must produce an empty string, never a block of bare
// headers with nothing under them.
assert.equal(buildMeetingNotesSummaryText({
  summary: "", donorInterests: "", fundraisingOpportunities: "", confirmedCommitments: "", possibleCommitments: "", relationshipContext: "",
}), "");

console.log("meeting-notes-format.test.mjs: all assertions passed");
