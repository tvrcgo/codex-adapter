import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface BackendConfig {
  name: string;
  model: string;
  baseUrl: string;
  completionsPath: string;
  apiKey: string;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface AdapterConfig {
  port: number;
  backends: BackendConfig[];
  defaultBackend: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

const defaultExtraBody = {
  stream_options: { include_usage: true },
};

interface RawBackend {
  name?: string;
  model?: string;
  default?: boolean;
  base_url?: string;
  completions_path?: string;
  api_key?: string;
  max_tokens?: number;
  extra_headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
}

interface RawConfig {
  port?: number;
  log_level?: string;
  backends?: RawBackend[];
  // legacy single-backend format
  backend?: RawBackend & { model?: string };
  models?: string[];
}

function parseBackend(b: RawBackend, index: number): BackendConfig {
  const model = b.model ?? `model-${index}`;
  return {
    name: b.name ?? model,
    model,
    baseUrl: b.base_url ?? "http://localhost:8000",
    completionsPath: b.completions_path ?? "/chat/completions",
    apiKey: b.api_key ?? "",
    maxTokens: b.max_tokens,
    extraHeaders: b.extra_headers,
    extraBody: b.extra_body ?? defaultExtraBody,
  };
}

export function resolveBackend(config: AdapterConfig, modelName?: string): BackendConfig | undefined {
  if (!modelName) {
    return config.backends.find((b) => b.name === config.defaultBackend) ?? config.backends[0];
  }
  return (
    config.backends.find((b) => b.model === modelName) ??
    config.backends.find((b) => b.name === modelName) ??
    config.backends.find((b) => b.name === config.defaultBackend) ??
    config.backends[0]
  );
}

export function loadConfig(configPath?: string): AdapterConfig {
  const path = configPath ?? resolve(process.cwd(), "config.yml");

  if (!existsSync(path)) {
    console.warn(`[config] ${path} not found, using defaults`);
    return { port: 3321, backends: [], defaultBackend: "", logLevel: "info" };
  }

  const raw = yaml.load(readFileSync(path, "utf-8")) as RawConfig | null;
  if (!raw || typeof raw !== "object") {
    console.warn("[config] config.yml is empty or invalid, using defaults");
    return { port: 3321, backends: [], defaultBackend: "", logLevel: "info" };
  }

  let backends: BackendConfig[] = [];
  let defaultBackend = "";

  if (raw.backends?.length) {
    backends = raw.backends.map((b, i) => parseBackend(b, i));
    const explicit = raw.backends.findIndex((b) => b.default === true);
    defaultBackend = backends[explicit >= 0 ? explicit : 0].name;
  } else if (raw.backend) {
    const b = parseBackend(raw.backend, 0);
    backends = [b];
    defaultBackend = b.name;
  }

  return {
    port: raw.port ?? 3321,
    backends,
    defaultBackend,
    logLevel: (raw.log_level as AdapterConfig["logLevel"]) ?? "info",
  };
}
