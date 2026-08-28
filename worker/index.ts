/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runWithWorkspaceBriefRequestScope } from "../lib/workspace/live-data";
import { runScheduledAgendaSend } from "../lib/agenda/send-agenda";
import { runScheduledBackupAlertCheck } from "../lib/backup-alert/run";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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
  // hourly Cron Trigger ("0 * * * *") registered in wrangler.staging.jsonc
  // (see that file's own comment for the full approval record).
  // runScheduledAgendaSend() itself is the DST-safe 9 AM America/New_York
  // guard (lib/agenda/send-agenda.ts's isDailyAgendaSendHour()) -- this
  // handler does no time-zone logic of its own, just passes through the
  // trigger's own scheduled time and extends the Worker's lifetime with
  // waitUntil() so Cloudflare doesn't terminate it before the send (or
  // its failure) completes. 23 of every 24 hourly invocations are an
  // intentional, silent no-op; only the one where the real local hour
  // reads 9 actually sends.
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
