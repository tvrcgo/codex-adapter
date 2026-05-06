import { promises as fs } from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const RECORDS_DIR = "records";

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

/**
 * Request record structure saved for replay/automation.
 */
export interface RequestRecord {
  id: string;
  timestamp: string;
  model: string;
  request: unknown;          // Original ResponsesRequest
  transformedRequest: unknown;  // ChatCompletionsRequest sent to backend
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

/**
 * Save a request record to disk for later replay/automation.
 * Returns the record ID for later reference.
 */
export async function saveRequestRecord(
  request: unknown,
  transformedRequest: unknown,
  model: string
): Promise<string> {
  await ensureRecordsDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `req_${timestamp}`;

  const record: RequestRecord = {
    id,
    timestamp: new Date().toISOString(),
    model,
    request,
    transformedRequest,
  };

  const filePath = path.join(RECORDS_DIR, `${id}.json`);

  try {
    await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
    logger.info(`[Recorder] Saved request record: ${id}`);
    return id;
  } catch (err) {
    logger.error(`[Recorder] Failed to save request record: ${err}`);
    return "";
  }
}

/**
 * Load a request record by ID.
 */
export async function loadRequestRecord(id: string): Promise<RequestRecord | null> {
  await ensureRecordsDir();

  const filePath = path.join(RECORDS_DIR, `${id}.json`);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as RequestRecord;
  } catch (err) {
    logger.error(`[Recorder] Failed to load request record ${id}: ${err}`);
    return null;
  }
}

/**
 * List all request records.
 */
export async function listRequestRecords(): Promise<Array<{ id: string; timestamp: string; model: string }>> {
  await ensureRecordsDir();

  try {
    const files = await fs.readdir(RECORDS_DIR);
    const records: Array<{ id: string; timestamp: string; model: string }> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(RECORDS_DIR, file), "utf-8");
        const record = JSON.parse(content) as RequestRecord;
        records.push({
          id: record.id,
          timestamp: record.timestamp,
          model: record.model,
        });
      } catch {}
    }

    return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch (err) {
    logger.error(`[Recorder] Failed to list request records: ${err}`);
    return [];
  }
}

/**
 * Update a request record with response info.
 */
export async function updateRequestRecord(
  id: string,
  update: {
    response?: { status: "completed" | "failed"; output?: unknown; error?: string };
    toolCalls?: Array<{ call_id: string; name: string; arguments: string }>;
  }
): Promise<void> {
  await ensureRecordsDir();

  const filePath = path.join(RECORDS_DIR, `${id}.json`);

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
 * Delete a request record.
 */
export async function deleteRequestRecord(id: string): Promise<boolean> {
  await ensureRecordsDir();

  const filePath = path.join(RECORDS_DIR, `${id}.json`);

  try {
    await fs.unlink(filePath);
    logger.info(`[Recorder] Deleted request record: ${id}`);
    return true;
  } catch (err) {
    logger.error(`[Recorder] Failed to delete request record ${id}: ${err}`);
    return false;
  }
}

/**
 * Get all pending tool calls (requests that have tool_calls but no response yet).
 * Useful for automation - find work that needs to be done.
 */
export async function getPendingToolCalls(): Promise<Array<{
  recordId: string;
  timestamp: string;
  toolCalls: Array<{ call_id: string; name: string; arguments: string }>;
}>> {
  await ensureRecordsDir();

  const files = await fs.readdir(RECORDS_DIR);
  const pending: Array<{
    recordId: string;
    timestamp: string;
    toolCalls: Array<{ call_id: string; name: string; arguments: string }>;
  }> = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(RECORDS_DIR, file), "utf-8");
      const record = JSON.parse(content) as RequestRecord;

      // Check if this record has tool calls that need execution
      if (record.toolCalls && record.toolCalls.length > 0) {
        pending.push({
          recordId: record.id,
          timestamp: record.timestamp,
          toolCalls: record.toolCalls,
        });
      }
    } catch {}
  }

  return pending.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}