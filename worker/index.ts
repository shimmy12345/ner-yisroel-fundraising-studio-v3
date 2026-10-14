/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runWithWorkspaceBriefRequestScope } from "../lib/workspace/live-data";
import { runScheduledAgendaSend } from "../lib/agenda/send-agenda";
import { runScheduledBackupAlertCheck } from "../lib/backup-alert/run";
import { deploymentEnvironment } from "../lib/environment";
import { shouldBlockStagingWrite, STAGING_READ_ONLY_MESSAGE, stagingReadOnlyResponseInit } from "../lib/operations/staging-write-guard";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  // Independent Staging's read-only write guard escape hatch -- see
  // lib/operations/staging-write-guard.ts. Absent/not "true" (the
  // default, and the only value on Production regardless) means every
  // mutating /api/** request on the independent staging deployment is
  // blocked.
  STAGING_WRITES_ENABLED?: string;
  // Not bound on the independent staging Worker (Cloudflare Images is not
  // required to run the app). When absent, image requests are served
  // unoptimized rather than transformed.
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Minimal shape of Cloudflare's real ScheduledController -- only the one
// field this Worker actually reads, matching this file's existing
// hand-rolled-interface convention (see ExecutionContext/Env above)
// rather than pulling in @cloudflare/workers-types.
interface ScheduledController {
  scheduledTime: number;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Independent Staging read-only enforcement (Production Operational
    // Transition, docs/AI-HANDOFF.md) -- checked before any routing, so
    // no API route (existing or future) can bypass it. Never matches on
    // Production: shouldBlockStagingWrite only returns true when
    // deploymentEnvironment === "staging-independent", a value Production
    // never resolves to. See lib/operations/staging-write-guard.ts.
    if (shouldBlockStagingWrite(deploymentEnvironment, request.method, url.pathname, env.STAGING_WRITES_ENABLED)) {
      return Response.json({ error: STAGING_READ_ONLY_MESSAGE }, stagingReadOnlyResponseInit());
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const images = env.IMAGES;
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        ...(images ? {
          transformImage: async (body, { width, format, quality }) => {
            const result = await images.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        } : {}),
      }, allowedWidths);
    }

    // Wraps the entire per-request vinext dispatch (which internally calls
    // the matched page component's Server Component function up to twice
    // -- see lib/workspace/live-data.ts's comment on
    // runWithWorkspaceBriefRequestScope for why) in one
    // AsyncLocalStorage.run(), so loadWorkspaceBrief() can dedupe its own
    // expensive work across those two calls within this one request. Uses
    // only run()/getStore() -- Cloudflare Workers' AsyncLocalStorage does
    // not implement enterWith()/disable().
    return runWithWorkspaceBriefRequestScope(() => handler.fetch(request, env, ctx));
  },

  // Daily Fundraising Agenda email -- APPROVED and ACTIVE. Runs on the
  // hourly Cron Trigger ("0 * * * *") registered in
  // wrangler.production.jsonc (moved there from wrangler.staging.jsonc in
  // the 2026-10-12 Production Daily Email Cutover; see that file's own
  // comment for the full approval record). This same code is also bundled
  // into Independent Staging's Worker (there is only one worker/index.ts),
  // so this handler itself NEVER assumes which environment it is running
  // in -- lib/agenda/email-send-guard.ts's fail-closed allowlist, enforced
  // inside the Gmail-sending function itself, is what actually stops a real send from
  // anywhere other than Independent Production, regardless of which
  // Worker's Cron Trigger state caused this function to run (see
  // docs/AI-HANDOFF.md's "October 14 Email Incident" entry for why that
  // distinction matters: a wrangler.jsonc config change alone was not
  // sufficient). runScheduledAgendaSend() itself is the DST-safe 9 AM
  // America/New_York guard (lib/agenda/send-agenda.ts's
  // isDailyAgendaSendHour()) plus a concurrency-safe idempotency claim
  // (lib/agenda/send-log.ts) -- this handler does no time-zone or dedup
  // logic of its own, just passes through the trigger's own scheduled
  // time and extends the Worker's lifetime with waitUntil() so Cloudflare
  // doesn't terminate it before the send (or its failure) completes. 23
  // of every 24 hourly invocations are an intentional, silent no-op; only
  // the one where the real local hour reads 9 even attempts a send.
  // Backup Scheduling Reliability Stage 3 email alert -- APPROVED and
  // ACTIVE, sharing this same hourly Cron Trigger rather than adding a
  // second one. A completely separate waitUntil() from the Daily Agenda
  // above: each waitUntil() is tracked independently by Cloudflare, so a
  // failure or rejection in one can never affect whether the other runs
  // or how it's reported (see lib/backup-alert/run.ts's own header
  // comment for why this check specifically never throws on its own).
  // Passed controller.scheduledTime directly (epoch milliseconds) rather
  // than the Daily Agenda's epoch-SECONDS `now` above -- lib/backup-alert
  // and lib/backup-status/freshness.ts share the millisecond convention
  // already used by lib/data-health/model.ts and
  // status-worker/src/watchdog.ts, not the agenda code's own seconds one.
  async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledAgendaSend(Math.floor(controller.scheduledTime / 1000)));
    ctx.waitUntil(runScheduledBackupAlertCheck(controller.scheduledTime));
  },
};

export default worker;
