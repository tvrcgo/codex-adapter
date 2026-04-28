# codex-adapter

将 OpenAI **Responses API** 转换为 **Chat Completions API** 的代理服务，让 [Codex App](https://github.com/openai/codex) 能对接任何兼容 OpenAI 接口的后端。

[English](README.md)

```
Codex App ──(Responses API)──▶ codex-adapter ──(Chat Completions API)──▶ 后端
```

## 特性

- 双向 SSE 流式转换（Responses API ↔ Chat Completions）
- 函数调用 / 工具使用，支持多工具批量调用
- 多后端配置，按模型名称自动路由
- 每个后端独立配置自定义请求头和请求体
- 空响应检测，返回 `context_length_exceeded` 触发客户端自动压缩上下文

## 配置

从示例创建配置文件：

```bash
cp config.example.yml config.yml
```

```yaml
port: 3321
log_level: info

backends:
  - name: backend-a
    model: model-a            # 单模型
    default: true
    url: https://api.example.com/v1/chat/completions
    api_key: your-key
    max_tokens: 128000
    extra_body:
      stream_options:
        include_usage: true

  - name: backend-b
    models:                   # 多模型
      - model-b
      - model-b-fast
    url: https://other-api.example.com/v1/chat/completions
    api_key: another-key
    max_tokens: 64000
```

路由逻辑：请求中的 `model` 匹配 → 对应后端，无匹配 → `default` 后端，无默认 → 列表第一个。

## Docker 部署

```bash
cp config.example.yml config.yml   # 编辑填入你的配置
docker-compose up -d --build
```

`config.yml` 在构建时打包进镜像，修改配置后需重新构建。

## Codex CLI 配置

```toml
# ~/.codex/config.toml
model = "model-a"
model_provider = "adapter"
model_context_window = 128000      # 启用自动上下文压缩

[model_providers.adapter]
name = "codex-adapter"
base_url = "http://localhost:3321/v1"
env_key = "ADAPTER_API_KEY"
wire_api = "responses"
```

## 许可证

MIT
