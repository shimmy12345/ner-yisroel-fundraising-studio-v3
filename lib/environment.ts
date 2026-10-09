// Single source of truth for classifying the running deployment. Anything
// gating a staging-independent-only feature (e.g. a destructive reset)
// should import this rather than re-deriving __FUNDRAISING_OS_ENVIRONMENT__,
// so there is exactly one place that can get the four-way check wrong.
//
// "production-independent" (added 2026-10-09, see
// docs/PRODUCTION-INFRASTRUCTURE-SETUP.md) is this app's own independent
// Cloudflare Production Worker/D1 -- NOT a relabeling of legacy
// "production" (the ChatGPT Sites platform). Before this value existed,
// an independent Production Worker built with scripts/build-production.mjs
// (the only "production" build script that existed) would have resolved
// to the SAME "production" value legacy production uses, making the two
// indistinguishable by this check alone -- see lib/auth/
// provider-selection.ts's own doc comment for why that specific ambiguity
// mattered for authentication. Use scripts/build-production-independent.mjs
// for any independent Cloudflare Production build; scripts/
// build-production.mjs remains legacy-only, unchanged.
export const deploymentEnvironment: "staging" | "production" | "staging-independent" | "production-independent" =
  __FUNDRAISING_OS_ENVIRONMENT__ === "production" ? "production" :
  __FUNDRAISING_OS_ENVIRONMENT__ === "staging-independent" ? "staging-independent" :
  __FUNDRAISING_OS_ENVIRONMENT__ === "production-independent" ? "production-independent" :
  "staging";
