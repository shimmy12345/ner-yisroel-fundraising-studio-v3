type LogContext = Record<string, string | number | boolean | null>;

export const logger = {
  info(message: string, context: LogContext = {}) {
    console.info(JSON.stringify({ level: "info", message, ...context }));
  },
  error(message: string, error: unknown, context: LogContext = {}) {
    console.error(JSON.stringify({
      level: "error",
      message,
      error: error instanceof Error ? error.message : "Unknown error",
      ...context,
    }));
  },
};
