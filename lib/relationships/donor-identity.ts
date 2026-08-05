const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "rabbi", "rebbetzin", "rev", "reverend", "hon"]);
const NON_NAME_WORDS = new Set(["and", "family", "household", "the"]);

export type DonorIdentityInput = {
  displayName: string;
  primaryFirstName?: string | null;
  lastName?: string | null;
  donorCode?: string | null;
  externalId?: string | null;
};

function words(value: string | null | undefined) {
  return (value ?? "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, ""))
    .filter((word) => {
      const normalized = word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      return normalized && !HONORIFICS.has(normalized) && !NON_NAME_WORDS.has(normalized);
    });
}

function initial(value: string | undefined) {
  return value ? Array.from(value)[0]?.toLocaleUpperCase() ?? "" : "";
}

/** One shared, title-safe identity mark for every donor surface. */
export function donorInitials(input: DonorIdentityInput) {
  const primary = words(input.primaryFirstName);
  const explicitLast = words(input.lastName);
  const household = words(input.displayName);
  const first = primary[0];
  const last = explicitLast.at(-1) ?? household.at(-1);

  if (first && last && first.toLocaleLowerCase() !== last.toLocaleLowerCase()) return `${initial(first)}${initial(last)}`;
  if (first) return initial(first);
  if (household.length > 1) return `${initial(household[0])}${initial(household.at(-1))}`;
  return initial(household[0]) || "?";
}

/** JL identifiers are presented as the familiar numeric code, without labels. */
export function numericDonorCode(input: Pick<DonorIdentityInput, "donorCode" | "externalId">) {
  const digits = (input.externalId || input.donorCode || "").replace(/\D/g, "");
  return digits || null;
}
