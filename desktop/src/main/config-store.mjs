import { app } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  return join(app.getPath("userData"), "config");
}

const CONFIG_FILE = "config.yml";
const EXAMPLE_FILE = "config.example.yml";

function getExamplePath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, EXAMPLE_FILE);
  }
  return join(app.getAppPath(), "..", "..", EXAMPLE_FILE);
}

export function ensureConfig() {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const configPath = join(dir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    const example = getExamplePath();
    if (existsSync(example)) {
      copyFileSync(example, configPath);
    } else {
      writeFileSync(configPath, "port: 3321\nlog_level: info\nbackends: []\n", "utf-8");
    }
  }
  return configPath;
}

export function getConfigDir() {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readConfigContent() {
  const configPath = join(getDataDir(), CONFIG_FILE);
  if (!existsSync(configPath)) return "";
  return readFileSync(configPath, "utf-8");
}