// Portfolio Focus -- builds the shared, portfolio-wide percentile bases
// once per scoring run. Pure. See lib/portfolio-focus/types.ts for why
// this is separate from any one donor's own input.
import type { PortfolioFocusContext, PortfolioFocusDonorInput } from "./types.ts";

export function buildPortfolioContext(donorInputs: readonly PortfolioFocusDonorInput[], financialEventAmounts: readonly number[]): PortfolioFocusContext {
  const lifetimeValuesPositive = donorInputs.filter((d) => d.lifetimeCents > 0).map((d) => d.lifetimeCents);
  const historicalPeaksPositive = donorInputs
    .map((d) => Math.max(d.historicalPeakGiftCents ?? 0, d.historicalPeakCommitmentCents ?? 0))
    .filter((v) => v > 0);
  const distinctYearsPositive = donorInputs.filter((d) => d.distinctActivityYears > 0).map((d) => d.distinctActivityYears);
  const deltaAbsValues = donorInputs.filter((d) => d.prior365Cents > 0).map((d) => Math.abs(d.last365Cents - d.prior365Cents));
  return {
    lifetimeValuesPositive,
    historicalPeaksPositive,
    distinctYearsPositive,
    financialEventAmounts: [...financialEventAmounts],
    deltaAbsValues,
  };
}
