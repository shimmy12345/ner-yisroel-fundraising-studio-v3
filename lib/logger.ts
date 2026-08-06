type LogContext = Record<string, string | number | boolean | null>;

// userIdForEmail() (lib/auth/profile.ts) produces "user_<email>" — the
// correct identifier for database ownership, but never safe to write to an
// operational log verbatim. This pseudonymizes it at the logging boundary
// only: database rows, ownership checks, and everything else in the app
// keep using the real userId unchanged. Deterministic (same userId always
// produces the same pseudonym), so log lines for the same user can still be
// correlated during debugging, without the email appearing in log output.
//
// This is a log-hygiene measure, not a security boundary: since the
// transform is unsalted and the source is public, anyone who already
// suspects a specific email can recompute its pseudonym and match it
// against logs. It stops accidental plaintext exposure (dashboards,
// exports, screenshots) — it does not make the identifier unlinkable
// against a targeted guess.
function pseudonymizeIdentifier(value: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `user_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizeContext(context: LogContext): LogContext {
  if (typeof context.userId !== "string") return context;
  return { ...context, userId: pseudonymizeIdentifier(context.userId) };
}

export const logger = {
  info(message: string, context: LogContext = {}) {
    console.info(JSON.stringify({ level: "info", message, ...sanitizeContext(context) }));
  },
  error(message: string, error: unknown, context: LogContext = {}) {
    console.error(JSON.stringify({
      level: "error",
      message,
      error: error instanceof Error ? error.message : "Unknown error",
      ...sanitizeContext(context),
    }));
  },
};
