import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from "electron";
import { exec } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createPanelRouter } from "./panel-router.mjs";
import { ensureConfig, getConfigDir } from "./config-store.mjs";

app.setName("codex-adapter");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray = null;
let mainWindow = null;
let server = null;
let config = null;
let serverStarted = false;

function openDir(dir) {
  const cmd = process.platform === "win32"
    ? `explorer.exe "${dir}"`
    : process.platform === "darwin"
    ? `open "${dir}"`
    : `xdg-open "${dir}"`;
  exec(cmd);
}

function getIcon() {
  const sizes = [16, 32, 64];
  for (const size of sizes) {
    const iconPath = path.join(__dirname, "..", "assets", `icon-${size}.png`);
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) return icon.resize({ width: 16, height: 16 });
    } catch {}
  }
  return nativeImage.createEmpty();
}

async function startServer() {
  if (serverStarted) return;
  try {
    const configPath = ensureConfig();
    const { loadConfig } = await import("../../dist/config.js");
    config = loadConfig(configPath);
    const { setLogLevel, logger } = await import("../../dist/utils/logger.js");
    setLogLevel(config.logLevel ?? "info");

    const { createApp } = await import("../../dist/index.js");
    const expressApp = createApp(config);
    expressApp.use(createPanelRouter(config));

    server = expressApp.listen(config.port, () => {
      serverStarted = true;
      logger.info(`codex-adapter listening on http://localhost:${config.port}`);
      sendStatus();
      updateTrayMenu();
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
  }
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverStarted || !server) { resolve(); return; }
    server.close(() => {
      serverStarted = false;
      server = null;
      console.log("Server stopped");
      sendStatus();
      updateTrayMenu();
      resolve();
    });
  });
}

async function restartServer() {
  await stopServer();
  await startServer();
}

function sendStatus() {
  mainWindow?.webContents.send("server-status", {
    running: serverStarted,
    port: config?.port ?? 0,
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: serverStarted ? "停止服务" : "启动服务",
      click: async () => {
        if (serverStarted) await stopServer();
        else await startServer();
      },
    },
    {
      label: "重启服务",
      enabled: serverStarted,
      click: () => restartServer(),
    },
    { type: "separator" },
    {
      label: "打开配置目录",
      click: () => openDir(getConfigDir()),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        stopServer();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const icon = getIcon();
  tray = new Tray(icon);
  tray.setToolTip("Codex Adapter");
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
  updateTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    title: "Codex Adapter",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "panel.html"));

  mainWindow.on("close", (event) => {
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle("get-status", () => ({
    running: serverStarted,
    port: config?.port ?? 0,
  }));

  ipcMain.handle("start-server", async () => {
    await startServer();
    return { running: serverStarted, port: config?.port ?? 0 };
  });

  ipcMain.handle("stop-server", async () => {
    await stopServer();
    return { running: serverStarted, port: config?.port ?? 0 };
  });

  ipcMain.handle("restart-server", async () => {
    await restartServer();
    return { running: serverStarted, port: config?.port ?? 0 };
  });

  ipcMain.handle("open-config-dir", () => {
    openDir(getConfigDir());
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  startServer().then(() => {
    createTray();
    createWindow();
  });
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  stopServer();
});
