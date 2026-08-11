import type { FindingCategory } from "./types.ts";

// Rule-based only -- no LLM call, no synthesis of a claim from free text.
// The claim IS the evidence's own title, taken verbatim (see
// lib/research/pipeline.ts); this classifier's only job is picking which
// of the six sections a piece of evidence belongs in, from keyword
// patterns in its title/snippet. Falls through to notes_ambiguities when
// nothing matches, rather than guessing -- an unclassifiable finding is
// surfaced for a human to look at, not silently mis-filed.
// possible_connections is never produced here: it's derived separately, by
// matching organizationNormalized across donors (see pipeline.ts), because
// a shared affiliation is a relationship between two findings, not a
// property of one piece of text.
export function classifyEvidenceCategory(title: string, snippet: string): FindingCategory {
  const text = `${title} ${snippet}`.toLowerCase();
  if (/\b(board member|trustee|director|chair(person)?|advisory (board|council)|governing board|board of (directors|trustees))\b/.test(text)) return "boards_affiliations";
  if (/\b(honoree|honored|honoring|gala|sponsor(ed|ship)?|philanthropist|donat(ed|ion)|campaign|pledge(d)?|named gift|benefactor|underwrit(er|ten)|fundrais(er|ing))\b/.test(text)) return "public_philanthropy";
  if (/\b(ceo|chief executive|president|founder|co-founder|managing (partner|director)|executive (director|vice president)|partner at|joins? as|appointed|named (ceo|president|chief)|promoted to)\b/.test(text)) return "professional";
  if (/\b(news|announc|report(s|ed)?|profile|feature|interview|article|press release)\b/.test(text)) return "recent_mentions";
  return "notes_ambiguities";
}
