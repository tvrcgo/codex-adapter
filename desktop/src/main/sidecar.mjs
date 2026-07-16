import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { app } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

const INDEX = app.isPackaged
  ? join(process.resourcesPath, "dist", "index.js")
  : join(app.getAppPath(), "..", "dist", "index.js");

export function spawnServer(configPath, { onStart, onStop, onError, onLog }) {
  const dataDir = join(app.getPath("userData"), "data");

  const child = spawn(process.execPath, [INDEX, configPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_DATA_DIR: dataDir },
  });

  [child.stdout, child.stderr].forEach((s) =>
    s?.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => onLog?.(l)))
  );

  child.on("spawn", () => onStart?.());
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error("Server exited with code", code);
    onStop?.();
  });
  child.on("error", (err) => {
    console.error("Failed to spawn server:", err.message);
    onError?.(err);
  });

  return child;
}