# codex-adapter

Proxy that translates OpenAI **Responses API** requests (from Codex CLI) into **Chat Completions** format for internal backends that only support `/v1/chat/completions`.

```
Codex CLI ──(POST /v1/responses)──▶ codex-adapter ──(POST /v1/chat/completions)──▶ Internal API
```

## Quick Start

```bash
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

See [.env.example](.env.example) for all available configuration options.

Start the server:

```bash
npm start         # production (requires build)
npm run dev       # development with hot-reload
```

## Codex CLI Configuration

```toml
# ~/.codex/config.toml
model_provider = "internal"

[model_providers.internal]
name = "Internal API"
base_url = "http://localhost:3321/v1"
env_key = "CODEX_ADAPTER_KEY"
wire_api = "responses"
```

## Endpoints

| Endpoint | Description |
|---|---|
| `POST /v1/responses` | Accepts Responses API requests, translates and streams |
| `GET /v1/responses/:id` | Returns 404 (stateless proxy) |
| `GET /v1/models` | Lists available models |
| `GET /health` | Health check |

## Custom Backend Fields

By default the adapter injects these extra fields into every Chat Completions request:

```json
{
  "chat_template_kwargs": { "enable_thinking": false },
  "stream_options": { "include_usage": true }
}
```

Override via `ADAPTER_EXTRA_BODY` environment variable (JSON string).

## What's Supported

- Text generation (streaming)
- Function calling / tool use (streaming)
- System instructions (`instructions` → system message)
- Structured outputs (`text.format` → `response_format`)
- Multi-turn conversations via full input array
- Custom headers and body fields injection

## What's Not Supported

- `previous_response_id` chaining (Codex sends full context)
- Hosted tools (web_search, file_search, code_interpreter)
- Response storage / retrieval
- Image generation
