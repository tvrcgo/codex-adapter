# CHANGELOG

## [v1.1.0] - 2026-07-14

### 核心摘要
新增 Electron 桌面应用支持，Express 服务可嵌入桌面环境运行，提供系统托盘和管理面板。

### 变更
- 新增：Electron 桌面应用入口 (`src/electron/main.ts`)，集成系统托盘 + 管理面板
- 新增：管理面板 UI (`src/electron/panel.html`)，支持服务状态查看和启停
- 新增：管理面板 API (`src/routes/panel.ts`)，提供 /panel/status 查询接口
- 新增：桌面配置管理 (`src/electron/config-store.ts`)，配置存储在 %APPDATA%
- 新增：IPC 预加载脚本 (`src/electron/preload.ts`)
- 重构：`src/index.ts` 导出 `createApp()` 工厂函数，支持 CLI 和 Electron 双模式
- 新增：`npm run desktop` 命令用于开发模式运行桌面应用
- 新增：`npm run pack` 命令用于打包 Windows 安装包

### 上下文
- 项目原本仅支持 Docker 部署，新增桌面模式让用户可直接在 Windows 桌面运行服务
- Docker 部署方式不受影响，`src/index.ts` 中通过 `isElectron` 检测区分运行模式
