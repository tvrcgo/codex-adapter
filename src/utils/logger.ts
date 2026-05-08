import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let threshold: number = LEVELS.info;

const LOG_BASE_DIR = join(process.cwd(), "logs");
try { mkdirSync(LOG_BASE_DIR, { recursive: true }); } catch {}

let currentMonth = "";
let currentDate = "";
let logFile = "";

function ensureLogFile(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const monthStr = `${y}-${m}`;
  const dateStr = `${y}-${m}-${d}`;

  if (monthStr !== currentMonth) {
    currentMonth = monthStr;
    const monthDir = join(LOG_BASE_DIR, monthStr);
    if (!existsSync(monthDir)) mkdirSync(monthDir, { recursive: true });
  }

  if (dateStr !== currentDate) {
    currentDate = dateStr;
    logFile = join(LOG_BASE_DIR, monthStr, `${dateStr}.log`);
  }

  return logFile;
}

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
  try { appendFileSync(ensureLogFile(), line + "\n"); } catch {}
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
