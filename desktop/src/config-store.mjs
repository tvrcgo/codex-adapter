import { readFileSync, existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

const CONFIG_FILE = "config.yml";
const EXAMPLE_FILE = "config.example.yml";

function getUserConfigDir() {
  return join(app.getPath("userData"), "config");
}

function getUserConfigPath() {
  return join(getUserConfigDir(), CONFIG_FILE);
}

function getBundledExamplePath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, EXAMPLE_FILE);
  }
  return join(app.getAppPath(), "..", "..", "config.example.yml");
}

export function ensureConfig() {
  const configDir = getUserConfigDir();
  const configPath = getUserConfigPath();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  if (!existsSync(configPath)) {
    const examplePath = getBundledExamplePath();
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, configPath);
    } else {
      writeFileSync(configPath, "port: 3321\nlog_level: info\nbackends: []\n", "utf-8");
    }
  }

  return configPath;
}

export function getConfigDir() {
  const dir = getUserConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function readConfigContent() {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) return "";
  return readFileSync(configPath, "utf-8");
}
