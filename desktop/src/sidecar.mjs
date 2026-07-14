import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDEX = app.isPackaged
  ? path.join(process.resourcesPath, "dist", "index.js")
  : path.join(__dirname, "..", "..", "dist", "index.js");

export function spawnServer(configPath, { onStart, onStop, onError }) {
  const dataDir = path.join(app.getPath("userData"), "data");

  const child = spawn(process.execPath, [INDEX, configPath], {
    stdio: "pipe",
    env: {
      ...process.env,
      CODEX_DATA_DIR: dataDir,
    },
  });

  child.stdout?.on("data", (d) => process.stdout.write("[server] " + d));
  child.stderr?.on("data", (d) => process.stderr.write("[server] " + d));

  child.on("spawn", () => onStart?.());
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Server exited with code ${code}`);
    }
    onStop?.();
  });
  child.on("error", (err) => {
    console.error("Failed to spawn server:", err.message);
    onError?.(err);
  });

  return child;
}
