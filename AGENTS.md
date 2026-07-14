# codex-adapter

这是项目把 codex desktop app 的 responses 格式请求转换成 chat completions 格式，是一个协议的适配层，以便 codex desktop app 可以使用 chat completions 格式的 API。

## 架构

两层解耦：
- **server**（`src/`）：纯 Express 服务，`node dist/index.js config.yml` 直接启动
- **desktop**（`desktop/`）：Electron 壳，通过 `sidecar.mjs` 以子进程方式 `spawn` server，不 import server 源码
- Docker / CLI 只依赖 server 层，desktop 不进构建产物

## 部署

### Docker

```bash
docker-compose up -d --build
```

日志在 docker 容器 `codex-adapter` 中看

### 桌面应用

```bash
npm run build    # 编译
npm run desktop  # 开发模式运行 Electron
npm run pack     # 打包 Windows 安装包
```

桌面应用启动后：
- 系统托盘显示图标，Express 自动启动
- 左键托盘图标打开管理面板（服务状态 + 启停）
- 关闭窗口隐藏到托盘，右键退出
- 配置文件在 `%APPDATA%/codex-adapter/config/config.yml`

## 输出

- 本地调试日志在 `logs/`
- 请求录制放在 `records/`
- 测试用例在 `tests/`
- 临时测试脚本放在 `tmp/`

## 注意事项

- 整体原则：尽量不干预内容的输入输出，只做必要的协议转换和异常处理
- 任务执行过程中的临时文件，任务结束后要清理
- 项目根目录不要留临时文件

## 红线

- 不要把 `config.yml` 加到 git 中，涉及敏感信息（如密钥、token）