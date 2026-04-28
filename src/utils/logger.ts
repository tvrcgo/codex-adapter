import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let threshold: number = LEVELS.info;

const logDir = join(process.cwd(), "logs");
try { mkdirSync(logDir, { recursive: true }); } catch {}
const logFile = join(logDir, "adapter.log");

export function setLogLevel(level: keyof typeof LEVELS): void {
  threshold = LEVELS[level];
}

function log(level: keyof typeof LEVELS, msg: string, data?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const suffix = data !== undefined
    ? " " + (typeof data === "string" ? data : JSON.stringify(data))
    : "";
  const line = prefix + " " + msg + suffix;
  console.log(line);
  try { appendFileSync(logFile, line + "\n"); } catch {}
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
