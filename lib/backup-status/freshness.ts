// Shared, pure backup-freshness constants/logic -- the single source of
// truth for "how stale is too stale," used by BOTH the main app's
// Workspace Health dashboard (lib/data-health/model.ts) and the
// status-worker backup watchdog (status-worker/src/watchdog.ts). Extracted
// here specifically so the watchdog never duplicates or drifts from the
// dashboard's own already-shipped thresholds -- see
// docs/BACKUP-SCHEDULING-RELIABILITY.md Section 4 ("reuse existing
// constants/types/pure logic ... rather than copy-pasting values into an
// unrelated implementation").
//
// Zero dependencies (no D1, no Next.js, no Cloudflare-specific types) --
// safe to import from the main app's Node/Next.js build AND from
// status-worker's separate, minimal Wrangler bundle.
//
// Threshold rationale (unchanged from the original Workspace Health
// design, restated here since this is now the canonical home for these
// numbers):
//   - Nightly backup (`0 8 * * *`, ~24h cadence): a WATCHDOG recovery
//     dispatch at 26h (24h cadence + ~2h buffer, comfortably above the
//     19-37 minute scheduling jitter actually observed in this repo's
//     GitHub Actions run history); the dashboard's own "healthy" ceiling
//     stays 36h (24h + 12h grace) so a human is never alerted before the
//     watchdog has had a full ~10h window to self-heal; "critical" at 72h
//     (one full missed cycle, unchanged).
export const HOUR_MS = 3_600_000;

export const BACKUP_RECOVERY_THRESHOLD_MS = 26 * HOUR_MS;
export const BACKUP_FRESHNESS_HEALTHY_MS = 36 * HOUR_MS;
export const BACKUP_FRESHNESS_CRITICAL_MS = 72 * HOUR_MS;

export function freshnessStatus(ageMs: number, healthyBelowMs: number, criticalAboveMs: number): "healthy" | "attention" | "critical" {
  if (ageMs < healthyBelowMs) return "healthy";
  if (ageMs > criticalAboveMs) return "critical";
  return "attention";
}
