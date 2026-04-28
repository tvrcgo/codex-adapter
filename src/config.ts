import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface AdapterConfig {
  port: number;
  backend: {
    baseUrl: string;
    completionsPath: string;
    apiKey: string;
    model?: string;
    maxTokens?: number;
    extraHeaders?: Record<string, string>;
    extraBody?: Record<string, unknown>;
  };
  models?: string[];
  logLevel?: "debug" | "info" | "warn" | "error";
}

const defaults: AdapterConfig = {
  port: 3321,
  backend: {
    baseUrl: "http://localhost:8000",
    completionsPath: "/chat/completions",
    apiKey: "",
    extraBody: {
      chat_template_kwargs: { enable_thinking: false },
      stream_options: { include_usage: true },
    },
  },
  logLevel: "info",
};

interface RawConfig {
  port?: number;
  log_level?: string;
  models?: string[];
  backend?: {
    base_url?: string;
    completions_path?: string;
    api_key?: string;
    model?: string;
    max_tokens?: number;
    extra_headers?: Record<string, string>;
    extra_body?: Record<string, unknown>;
  };
}

export function loadConfig(configPath?: string): AdapterConfig {
  const path = configPath ?? resolve(process.cwd(), "config.yml");

  if (!existsSync(path)) {
    console.warn(`[config] ${path} not found, using defaults`);
    return defaults;
  }

  const raw = yaml.load(readFileSync(path, "utf-8")) as RawConfig | null;
  if (!raw || typeof raw !== "object") {
    console.warn("[config] config.yml is empty or invalid, using defaults");
    return defaults;
  }

  const b = raw.backend;

  return {
    port: raw.port ?? defaults.port,
    backend: {
      baseUrl: b?.base_url ?? defaults.backend.baseUrl,
      completionsPath: b?.completions_path ?? defaults.backend.completionsPath,
      apiKey: b?.api_key ?? defaults.backend.apiKey,
      model: b?.model,
      maxTokens: b?.max_tokens,
      extraHeaders: b?.extra_headers,
      extraBody: b?.extra_body ?? defaults.backend.extraBody,
    },
    models: raw.models,
    logLevel: (raw.log_level as AdapterConfig["logLevel"]) ?? defaults.logLevel,
  };
}
