import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface BackendConfig {
  name: string;
  models: string[];
  url: string;
  apiKey: string;
  maxTokens?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown> | null;  // null to disable default extraBody
  stripParams?: string[];
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
  models?: string[];
  default?: boolean;
  url?: string;
  api_key?: string;
  max_tokens?: number;
  extra_headers?: Record<string, string>;
  extra_body?: Record<string, unknown> | null;
  strip_params?: string[];
}

interface RawConfig {
  port?: number;
  log_level?: string;
  backends?: RawBackend[];
}

function parseModels(b: RawBackend, index: number): string[] {
  if (b.models?.length) return b.models;
  if (b.model) return [b.model];
  return [`model-${index}`];
}

function parseBackend(b: RawBackend, index: number): BackendConfig {
  const models = parseModels(b, index);

  // Handle extraBody: null disables default, empty object {} means no extras
  let extraBody: Record<string, unknown> | null | undefined;
  if (b.extra_body === null) {
    extraBody = null;  // Explicitly disable extraBody
  } else if (b.extra_body !== undefined) {
    extraBody = b.extra_body;
  } else {
    extraBody = defaultExtraBody;  // Default behavior
  }

  return {
    name: b.name ?? models[0],
    models,
    url: b.url ?? "http://localhost:8000/v1/chat/completions",
    apiKey: b.api_key ?? "",
    maxTokens: b.max_tokens,
    extraHeaders: b.extra_headers,
    extraBody,
    stripParams: b.strip_params,
  };
}

export function resolveBackend(config: AdapterConfig, modelName?: string): BackendConfig | undefined {
  if (!modelName) {
    return config.backends.find((b) => b.name === config.defaultBackend) ?? config.backends[0];
  }
  return (
    config.backends.find((b) => b.models.includes(modelName)) ??
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

  const backends = (raw.backends ?? []).map((b, i) => parseBackend(b, i));
  const explicit = (raw.backends ?? []).findIndex((b) => b.default === true);
  const defaultBackend = backends.length > 0
    ? backends[explicit >= 0 ? explicit : 0].name
    : "";

  return {
    port: raw.port ?? 3321,
    backends,
    defaultBackend,
    logLevel: (raw.log_level as AdapterConfig["logLevel"]) ?? "info",
  };
}