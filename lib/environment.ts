// Single source of truth for classifying the running deployment. Anything
// gating a staging-independent-only feature (e.g. a destructive reset)
// should import this rather than re-deriving __FUNDRAISING_OS_ENVIRONMENT__,
// so there is exactly one place that can get the three-way check wrong.
export const deploymentEnvironment: "staging" | "production" | "staging-independent" =
  __FUNDRAISING_OS_ENVIRONMENT__ === "production" ? "production" :
  __FUNDRAISING_OS_ENVIRONMENT__ === "staging-independent" ? "staging-independent" :
  "staging";
