// Shared phrasing for surfacing an unconfirmed donor_historical_context row
// on an institutional-memory surface (Meeting Brief, Assistant). Never used
// for interactions/recommendations -- this always names the source and
// always states the uncertainty explicitly, so it can never be mistaken
// for a confirmed contact.
export function importedContextLine(text: string, source: string, sourceDateLabel: string | null): string {
  const sourceLabel = source === "import-monday" ? "Monday.com" : source;
  const provenance = sourceDateLabel ? `${sourceLabel}, ${sourceDateLabel}` : sourceLabel;
  return `Prior imported context: "${text}" (${provenance}). Completion was never confirmed.`;
}
