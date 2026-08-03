import type { ImportDonor } from "../import/recognition.ts";

export type ManualDonorMatchRow = {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  home_phone: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

export type DonorMergeCandidate = {
  externalId: string;
  jlName: string;
  manualDonorId: string;
  manualName: string;
  reasons: string[];
};

function text(value: string | null | undefined) { return (value ?? "").trim().toLocaleLowerCase(); }
function digits(value: string | null | undefined) { return (value ?? "").replace(/\D/g, ""); }

export function findLikelyManualDonorMatches(jlDonors: ImportDonor[], manualDonors: ManualDonorMatchRow[]) {
  const candidates: DonorMergeCandidate[] = [];
  for (const donor of jlDonors) {
    let best: { row: ManualDonorMatchRow; score: number; reasons: string[] } | null = null;
    for (const row of manualDonors) {
      let score = 0;
      const reasons: string[] = [];
      if (text(donor.name) && text(donor.name) === text(row.display_name)) { score += 4; reasons.push("same household name"); }
      if (donor.email && text(donor.email) === text(row.email)) { score += 5; reasons.push("same email"); }
      const jlPhone = digits(donor.phone);
      if (jlPhone.length >= 7 && [digits(row.phone), digits(row.home_phone)].includes(jlPhone)) { score += 5; reasons.push("same phone"); }
      if (donor.contact?.addressLine1 && text(donor.contact.addressLine1) === text(row.address_line_1)) { score += 2; reasons.push("same address"); }
      if (donor.contact?.city && text(donor.contact.city) === text(row.city) && donor.contact?.state && text(donor.contact.state) === text(row.state)) { score += 2; reasons.push("same city and state"); }
      if (score >= 4 && (!best || score > best.score)) best = { row, score, reasons };
    }
    if (best && donor.donorCode) candidates.push({ externalId: donor.donorCode, jlName: donor.name, manualDonorId: best.row.id, manualName: best.row.display_name, reasons: best.reasons });
  }
  return candidates;
}
