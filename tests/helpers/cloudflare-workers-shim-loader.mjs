// Node module customization hook (module.register) that intercepts the
// "cloudflare:workers" specifier -- which does not exist outside an
// actual Workers runtime -- and resolves it to a tiny virtual module
// exporting a single, mutable `env` object. A test registers this loader
// BEFORE dynamically importing any D1-touching production file (e.g.
// lib/relationships/trips-data.ts), then sets properties directly on the
// `env` export (imported from cloudflare-workers-shim.mjs) before
// calling into that production code. This is the ONE piece of test
// infrastructure that lets a test exercise the REAL write functions
// (not a hand-copied reimplementation of their SQL) under plain Node --
// see tests/trip-reconciliation-concurrency.test.mjs for what this does
// and doesn't prove, and for why every OTHER test in this codebase
// treats "imports cloudflare:workers" as a hard wall instead.
const SHIM_SPECIFIER = "cloudflare:workers";
const SHIM_URL = new URL("./cloudflare-workers-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === SHIM_SPECIFIER) return { url: SHIM_URL, shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // This codebase's own .ts source files import sibling .ts modules by
    // their bare, extensionless specifier (the vinext/Vite bundler this
    // app actually ships with resolves that the same way webpack/tsc
    // "bundler" moduleResolution does) -- plain Node's own ESM resolver
    // does not. Retrying with ".ts" appended, ONLY for a relative
    // specifier that failed to resolve as-is, lets a test import real
    // production .ts files (and their own relative imports) without
    // changing a single production source file's own import style.
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z0-9]+$/i.test(specifier)) {
      return await nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
