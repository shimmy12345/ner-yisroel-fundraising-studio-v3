// A Node ESM loader hook (node:module's register()) that redirects the
// specifier "cloudflare:workers" to fake-cloudflare-workers.mjs's own
// mutable `env` object -- there is no such built-in module under plain
// Node (it only exists inside an actual Cloudflare Workers/vinext
// runtime), so importing it directly would throw ERR_MODULE_NOT_FOUND.
//
// This is what lets tests/trip-entrypoints-atomicity.test.mjs call the
// ACTUAL exported functions in lib/relationships/trips-data.ts (which
// does `import { env } from "cloudflare:workers"`) against a REAL local
// D1 database, rather than re-implementing or stubbing out their own
// logic -- "test the actual application entry points... do not
// substitute a stand-in UPDATE for the actual meeting operation."
//
// Must be registered via `register()` BEFORE trips-data.ts (or anything
// that imports it) is itself imported -- static imports resolve during
// the initial module graph load, before any of a file's own top-level
// code (including a register() call in that same file) has run, so the
// caller must use a DYNAMIC `await import(...)` for trips-data.ts (and
// anything re-exporting it), never a static `import ... from`.
//
// Node's own default resolver silently probes sibling extensions
// (`.ts`, `.tsx`, ...) for an extensionless relative specifier (several
// files this repo imports, e.g. meeting-brief.ts's own `./meeting-brief
// -model`, rely on exactly this) -- but that probing is NOT reachable
// through a custom resolve hook's own `nextResolve(specifier, context)`
// call, which only tries the EXACT specifier. Confirmed directly: the
// same import that resolves cleanly with no loader registered throws
// ERR_MODULE_NOT_FOUND once this hook is registered, unless this hook
// re-implements that probing itself for the one case that needs it --
// a bare relative specifier with no extension that the exact-match
// attempt failed to find.
const stubHref = new URL("./fake-cloudflare-workers.mjs", import.meta.url).href;
const PROBE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: stubHref, shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
    for (const extension of PROBE_EXTENSIONS) {
      const candidateSpecifier = `${specifier}${extension}`;
      try {
        return await nextResolve(candidateSpecifier, context);
      } catch {
        // keep probing the remaining extensions
      }
    }
    throw error;
  }
}
