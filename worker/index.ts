/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runWithWorkspaceBriefRequestScope } from "../lib/workspace/live-data";

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
};

export default worker;
