// Builds the single readable text block saved into interactions.summary
// (that column is free text -- there is no separate column per organized
// section, by design: see db/schema.ts's own interactions table comment on
// reusing the existing model rather than a parallel notes system). Only
// sections with real content are included, so a quick manual note (no AI
// organization, no interests/opportunities/commitments) saves as a clean
// single paragraph rather than a form full of empty headers.
//
// Pure and dependency-free -- the client component calls this just before
// POSTing to /api/meeting-notes; nothing server-side needs to reconstruct
// or re-derive it.

export type MeetingNotesSections = {
  summary: string;
  donorInterests: string;
  fundraisingOpportunities: string;
  confirmedCommitments: string;
  possibleCommitments: string;
  relationshipContext: string;
};

function section(title: string, body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  return `${title}\n${trimmed}`;
}

export function buildMeetingNotesSummaryText(sections: MeetingNotesSections): string {
  const parts = [
    section("Meeting Summary:", sections.summary),
    section("Donor Interests:", sections.donorInterests),
    section("Fundraising Opportunities:", sections.fundraisingOpportunities),
    section("Confirmed Commitments:", sections.confirmedCommitments),
    section("Possible Commitments / Discussions:", sections.possibleCommitments),
    section("Relationship Context:", sections.relationshipContext),
  ].filter((part): part is string => part !== null);
  return parts.join("\n\n").trim();
}
