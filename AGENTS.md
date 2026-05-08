# codex-adapter

这是项目把 codex desktop app 的 responses 格式请求转换成 chat completions 格式，是一个协议的适配层，以便 codex desktop app 可以使用 chat completions 格式的 API。

## 构建部署

使用 docker 来构建和部署项目

```bash
docker-compose up -d --build
```

日志在 docker 容器 `codex-adapter` 中看

## 输出

- 本地调试日志在 `logs/`
- 测试用例在 `tests/`
- 临时测试脚本放在 `tmp/`

## 编码规范

- 定位问题时，在必要的输入、输出、关键节点添加足够的日志，以满足全流程自动化验证的要求
- 问题要找到根因，从源头解决，不要因为一个可能的异常，各个分支到处做兜底和防御
- 一个方法可能出现的异常，要在方法内部去处理好，不要在外层调用方去做多种异常捕获和处理
- 不能为了方便，绕过问题根因，用打补丁、过滤异常、兜底的方式处理
- commit message 格式：`类型: 概括描述改动点`；commit 详情用列表格式逐行列出主要改动点，不要罗列代码（通过 claude 提交的 commit 加上 Co-authored-by: claude <noreply@anthropic.com>；通过 codex 提交的 commit 加上 Co-authored-by: codex <codex@openai.com>）

## 注意事项

- 任务执行过程中的临时文件，任务结束后要清理
- 项目根目录不要留临时文件
- 所有修改先部署到docker再调试

## 红线

- 不要把 `config.yml` 加到 git 中，涉及敏感信息（如密钥、token）