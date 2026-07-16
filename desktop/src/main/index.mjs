import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron";
import { exec } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { ensureConfig, getConfigDir, readConfigContent } from "./config-store.mjs";
import { spawnServer } from "./sidecar.mjs";

app.setName("codex-adapter");

const __dirname = dirname(fileURLToPath(import.meta.url));

let tray = null;
let mainWindow = null;
let child = null;
let serverPort = 0;
let serverStarted = false;
let logLines = [];

function openDir(dir) {
  const cmd = process.platform === "win32"
    ? `explorer.exe "${dir}"`
    : process.platform === "darwin"
    ? `open "${dir}"`
    : `xdg-open "${dir}"`;
  exec(cmd);
}

function sendStatus() {
  mainWindow?.webContents.send("server-status", {
    running: serverStarted,
    port: serverPort,
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: serverStarted ? "停止服务" : "启动服务",
      click: async () => {
        if (serverStarted) await stopServer();
        else startServer();
      },
    },
    { label: "重启服务", enabled: serverStarted, click: () => restartServer() },
    { type: "separator" },
    { label: "打开配置目录", click: () => openDir(getConfigDir()) },
    { type: "separator" },
    { label: "退出", click: () => stopServer().then(() => app.quit()) },
  ]);
  tray.setContextMenu(contextMenu);
}

function startServer() {
  return new Promise((resolve) => {
    if (serverStarted) { resolve(); return; }
    const configPath = ensureConfig();
    const m = readConfigContent().match(/^port:\s*(\d+)/m);
    serverPort = m ? parseInt(m[1]) : 3321;
    const LOG_LIMIT = 500;
    child = spawnServer(configPath, {
      onStart: () => { serverStarted = true; sendStatus(); updateTrayMenu(); resolve(); },
      onStop: () => { serverStarted = false; child = null; sendStatus(); updateTrayMenu(); },
      onError: () => { serverStarted = false; child = null; resolve(); },
      onLog: (line) => {
        logLines.push(line);
        if (logLines.length > LOG_LIMIT) logLines.shift();
        mainWindow?.webContents.send("server-log", line);
      },
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) { resolve(); return; }
    child.on("exit", () => {
      serverStarted = false; child = null; sendStatus(); updateTrayMenu(); resolve();
    });
    child.kill();
  });
}

async function restartServer() {
  await stopServer();
  await startServer();
}

// IPC handlers
ipcMain.handle("get-status", () => ({ running: serverStarted, port: serverPort }));
ipcMain.handle("get-logs", () => logLines);
ipcMain.handle("start-server", async () => { await startServer(); return { running: serverStarted, port: serverPort }; });
ipcMain.handle("stop-server", async () => { await stopServer(); return { running: serverStarted, port: serverPort }; });
ipcMain.handle("restart-server", async () => { await restartServer(); return { running: serverStarted, port: serverPort }; });
ipcMain.handle("open-config-dir", () => openDir(getConfigDir()));

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Codex Adapter");
  tray.on("click", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
  updateTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640, height: 600, resizable: true, minWidth: 560, minHeight: 400,
    title: "Codex Adapter",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", (event) => { event.preventDefault(); mainWindow?.hide(); });
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => { createTray(); createWindow(); startServer(); });
app.on("window-all-closed", () => {});
app.on("before-quit", () => stopServer());