// Hard rule E: missing information must never be worded as a judgment
// about the relationship itself ("this relationship is weak"). Every
// piece of end-user-facing text this module produces (headline,
// explanation, whyNow, whatFosDoesNotKnow, possibleAction) is checked
// against this list. This is enforced at runtime (throws), not just by
// convention in the template code, so a future edit to a template
// cannot silently reintroduce a banned phrase without a test catching
// it -- see tests/fundraising-intelligence.test.mjs.
const BANNED_PHRASES: RegExp[] = [
  /relationship (?:is|seems?|appears?) weak/i,
  /weak relationship/i,
  /poor relationship/i,
  /relationship (?:is|seems?|appears?) (?:cold|dying|dead)/i,
  /this donor (?:doesn'?t|does not) care/i,
];

export function assertSafeBriefText(text: string, context: string): string {
  for (const pattern of BANNED_PHRASES) {
    if (pattern.test(text)) {
      throw new Error(`Fundraising Intelligence Brief: banned relationship-judgment phrase found in ${context}: "${text}"`);
    }
  }
  return text;
}
