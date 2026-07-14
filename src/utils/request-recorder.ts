import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const RECORDS_DIR = process.env.CODEX_DATA_DIR
  ? path.join(process.env.CODEX_DATA_DIR, "records")
  : "records";

let recordsDirReady = false;

async function ensureRecordsDir(): Promise<void> {
  if (recordsDirReady) return;
  try {
    await fs.mkdir(RECORDS_DIR, { recursive: true });
    recordsDirReady = true;
  } catch (err) {
    logger.error(`Failed to create records directory: ${err}`);
  }
}

function toLocalIsoString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const H = String(date.getHours()).padStart(2, "0");
  const M = String(date.getMinutes()).padStart(2, "0");
  const S = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}-${m}-${d}T${H}:${M}:${S}.${ms}`;
}

function extractDateFromId(id: string): string {
  const match = id.match(/^req_(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : toLocalIsoString(new Date()).slice(0, 10);
}

async function ensureDateDir(dateDir: string): Promise<void> {
  try {
    await fs.mkdir(dateDir, { recursive: true });
  } catch (err) {
    logger.error(`Failed to create date directory ${dateDir}: ${err}`);
  }
}

/**
 * Request record structure saved for replay/automation.
 */
export interface RequestRecord {
  id: string;
  timestamp: string;
  model: string;
  request: unknown;
  transformedRequest: unknown;
  response?: {
    status: "completed" | "failed";
    output?: unknown;
    error?: string;
  };
  toolCalls?: Array<{
    call_id: string;
    name: string;
    arguments: string;
  }>;
}

export async function saveRequestRecord(
  request: unknown,
  transformedRequest: unknown,
  model: string
): Promise<string> {
  await ensureRecordsDir();

  const now = new Date();
  const timestamp = toLocalIsoString(now).replace(/[:.]/g, "-");
  const id = `req_${timestamp}`;
  const dateStr = extractDateFromId(id);
  const dateDir = path.join(RECORDS_DIR, dateStr);
  await ensureDateDir(dateDir);

  const record: RequestRecord = {
    id,
    timestamp: toLocalIsoString(now),
    model,
    request,
    transformedRequest,
  };

  const filePath = path.join(dateDir, `${id}.json`);

  try {
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
    logger.info(`[Recorder] Saved request record: ${id}`);
    return id;
  } catch (err) {
    logger.error(`[Recorder] Failed to save request record: ${err}`);
    return "";
  }
}

export async function loadRequestRecord(id: string): Promise<RequestRecord | null> {
  await ensureRecordsDir();

  const dateStr = extractDateFromId(id);
  const dateDir = path.join(RECORDS_DIR, dateStr);
  const filePath = path.join(dateDir, `${id}.json`);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as RequestRecord;
  } catch (err) {
    logger.error(`[Recorder] Failed to load request record ${id}: ${err}`);
    return null;
  }
}

export async function listRequestRecords(): Promise<Array<{ id: string; timestamp: string; model: string }>> {
  await ensureRecordsDir();

  try {
    const dateDirs = await fs.readdir(RECORDS_DIR);
    const records: Array<{ id: string; timestamp: string; model: string }> = [];

    for (const dateDir of dateDirs) {
      const datePath = path.join(RECORDS_DIR, dateDir);
      const stat = await fs.stat(datePath).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const files = await fs.readdir(datePath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = await fs.readFile(path.join(datePath, file), "utf-8");
          const record = JSON.parse(content) as RequestRecord;
          records.push({
            id: record.id,
            timestamp: record.timestamp,
            model: record.model,
          });
        } catch {}
      }
    }

    return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch (err) {
    logger.error(`[Recorder] Failed to list request records: ${err}`);
    return [];
  }
}

export async function updateRequestRecord(
  id: string,
  update: {
    response?: { status: "completed" | "failed"; output?: unknown; error?: string };
    toolCalls?: Array<{ call_id: string; name: string; arguments: string }>;
  }
): Promise<void> {
  await ensureRecordsDir();

  const dateStr = extractDateFromId(id);
  const dateDir = path.join(RECORDS_DIR, dateStr);
  const filePath = path.join(dateDir, `${id}.json`);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const record = JSON.parse(content) as RequestRecord;

    if (update.response) {
      record.response = update.response;
    }
    if (update.toolCalls) {
      record.toolCalls = update.toolCalls;
    }

    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
    logger.debug(`[Recorder] Updated request record: ${id}`);
  } catch (err) {
    logger.error(`[Recorder] Failed to update request record ${id}: ${err}`);
  }
}

/**
 * Save the raw SSE response stream content paired with a request record.
 * File is saved as `{id}.sse` in the same date directory as the request.
 */
export async function saveResponseRecord(
  id: string,
  rawContent: string,
): Promise<void> {
  if (!id) return;
  await ensureRecordsDir();

  const dateStr = extractDateFromId(id);
  const dateDir = path.join(RECORDS_DIR, dateStr);
  await ensureDateDir(dateDir);

  const filePath = path.join(dateDir, `${id}.sse`);

  try {
    await fs.writeFile(filePath, rawContent, "utf-8");
    logger.info(`[Recorder] Saved response record: ${id}.sse (${(rawContent.length / 1024).toFixed(1)}KB)`);
  } catch (err) {
    logger.error(`[Recorder] Failed to save response record: ${err}`);
  }
}

export async function deleteRequestRecord(id: string): Promise<boolean> {
  await ensureRecordsDir();

  const dateStr = extractDateFromId(id);
  const dateDir = path.join(RECORDS_DIR, dateStr);
  const filePath = path.join(dateDir, `${id}.json`);

  try {
    await fs.unlink(filePath);
    logger.info(`[Recorder] Deleted request record: ${id}`);
    return true;
  } catch (err) {
    logger.error(`[Recorder] Failed to delete request record ${id}: ${err}`);
    return false;
  }
}

export async function getPendingToolCalls(): Promise<Array<{
  recordId: string;
  timestamp: string;
  toolCalls: Array<{ call_id: string; name: string; arguments: string }>;
}>> {
  await ensureRecordsDir();

  const dateDirs = await fs.readdir(RECORDS_DIR);
  const pending: Array<{
    recordId: string;
    timestamp: string;
    toolCalls: Array<{ call_id: string; name: string; arguments: string }>;
  }> = [];

  for (const dateDir of dateDirs) {
    const datePath = path.join(RECORDS_DIR, dateDir);
    const stat = await fs.stat(datePath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const files = await fs.readdir(datePath);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(datePath, file), "utf-8");
        const record = JSON.parse(content) as RequestRecord;

        if (record.toolCalls && record.toolCalls.length > 0) {
          pending.push({
            recordId: record.id,
            timestamp: record.timestamp,
            toolCalls: record.toolCalls,
          });
        }
      } catch {}
    }
  }

  return pending.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
