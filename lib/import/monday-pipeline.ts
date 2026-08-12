import { excelSerialToIsoDate, type MondayDonorBlock } from "./monday-workbook.ts";
import { classifyMondayDisposition, type MondayDisposition } from "./monday-classify.ts";
import { mondaySourceFingerprint } from "./monday-fingerprint.ts";

// Pure orchestration -- no D1 access. The caller (the preview API route)
// resolves the donor lookup map from D1 first (owner-scoped, live donors
// only) and passes it in, so this whole module -- and therefore the
// matching/classification/disposition decisions it makes -- is testable
// with plain assert against a fictional fixture, no database required.

export type MondayDonorLookup = Map<string, { id: string; displayName: string }>;

export type MondayMatch =
  | { status: "matched"; donorId: string; fosDisplayName: string; nameConflict: boolean }
  | { status: "unmatched_code" }
  | { status: "no_code" };

export type MondayPreviewRow = {
  mondayDonorName: string;
  code: string | null;
  match: MondayMatch;
  text: string;
  subitemIndex: number;
  dueDateRaw: string | null;
  dueDateIso: string | null;
  // Monday's own Status column (e.g. "Done"), carried straight through --
  // never consulted by classifyMondayDisposition and never affects
  // matching. Shown to the fundraiser as a hint; it cannot pre-select or
  // trigger a write on its own.
  status: string | null;
  disposition: MondayDisposition;
  fingerprint: string | null;
};

// Exact code match only -- Code is the sole match key. Name is compared
// only as a sanity check on an already-matched code, never as a fallback
// path to a match. Extracts each side's surname (Monday's "Last, First"
// prefix; the FOS side's own last token as a heuristic) and flags a
// conflict only when neither side's surname appears in the other --
// deliberately tolerant of expected Hebrew/English nickname and honorific
// differences ("Avraham"/"Abie", "Micky"/"Michael J"), which are not
// conflicts.
function surnamesAreConsistent(mondayName: string, fosDisplayName: string): boolean {
  const mondaySurname = mondayName.split(",")[0]?.trim().toLowerCase();
  if (!mondaySurname) return true;
  return fosDisplayName.toLowerCase().includes(mondaySurname);
}

export function matchMondayDonor(block: MondayDonorBlock, lookup: MondayDonorLookup): MondayMatch {
  if (!block.code) return { status: "no_code" };
  const found = lookup.get(block.code);
  if (!found) return { status: "unmatched_code" };
  return { status: "matched", donorId: found.id, fosDisplayName: found.displayName, nameConflict: !surnamesAreConsistent(block.name, found.displayName) };
}

export function buildMondayPreview(donorBlocks: MondayDonorBlock[], lookup: MondayDonorLookup, todayIso: string): MondayPreviewRow[] {
  const rows: MondayPreviewRow[] = [];
  for (const block of donorBlocks) {
    const match = matchMondayDonor(block, lookup);
    for (const subitem of block.subitems) {
      const dueDateIso = excelSerialToIsoDate(subitem.dueDateRaw);
      const disposition = classifyMondayDisposition(subitem.text, dueDateIso, todayIso);
      const fingerprint = block.code ? mondaySourceFingerprint({ donorCode: block.code, subitemIndex: subitem.index, text: subitem.text, dueDateRaw: subitem.dueDateRaw }) : null;
      rows.push({ mondayDonorName: block.name, code: block.code, match, text: subitem.text, subitemIndex: subitem.index, dueDateRaw: subitem.dueDateRaw, dueDateIso, status: subitem.status, disposition, fingerprint });
    }
  }
  return rows;
}
