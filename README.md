# codex-adapter

Proxy that translates OpenAI **Responses API** into **Chat Completions API**, enabling [Codex App](https://github.com/openai/codex) to work with any OpenAI-compatible backend.

[中文文档](README.zh-CN.md)

```
Codex App ──(Responses API)──▶ codex-adapter ──(Chat Completions API)──▶ Backend
```

## Features

- Bidirectional SSE stream translation (Responses API ↔ Chat Completions)
- Function calling / tool use with multi-tool batching
- Multiple backends with model-based routing
- Custom headers and body fields per backend
- Empty response detection → `context_length_exceeded` error for auto-compaction

## Configuration

Create `config.yml` from the example:

```bash
cp config.example.yml config.yml
```

```yaml
port: 3321
log_level: info

backends:
  - name: backend-a
    model: model-a            # single model
    default: true
    url: https://api.example.com/v1/chat/completions
    api_key: your-key
    max_tokens: 128000
    extra_body:
      stream_options:
        include_usage: true

  - name: backend-b
    models:                   # multiple models
      - model-b
      - model-b-fast
    url: https://other-api.example.com/v1/chat/completions
    api_key: another-key
    max_tokens: 64000
```

Requests are routed by the `model` field: match → corresponding backend, no match → `default` backend, no default → first in list.

## Docker

```bash
cp config.example.yml config.yml   # edit with your settings
docker-compose up -d --build
```

`config.yml` is baked into the image. Rebuild after changes.

## Codex CLI Setup

```toml
# ~/.codex/config.toml
model = "model-a"
model_provider = "adapter"
model_context_window = 128000      # enables auto-compaction

[model_providers.adapter]
name = "codex-adapter"
base_url = "http://localhost:3321/v1"
env_key = "ADAPTER_API_KEY"
wire_api = "responses"
```

## License

MIT
