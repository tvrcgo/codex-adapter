import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { exec } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import { ensureConfig, getConfigDir, readConfigContent } from "./config-store.mjs";
import { spawnServer } from "./sidecar.mjs";
import { registerIpcHandlers } from "./ipc.mjs";

app.setName("codex-adapter");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray = null;
let mainWindow = null;
let child = null;
let serverPort = 0;
let serverStarted = false;

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
        stopServer().then(() => app.quit());
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function startServer() {
  return new Promise((resolve) => {
    if (serverStarted) { resolve(); return; }
    const configPath = ensureConfig();
    const m = readConfigContent().match(/^port:\s*(\d+)/m);
    serverPort = m ? parseInt(m[1]) : 3321;

    child = spawnServer(configPath, {
      onStart: () => {
        serverStarted = true;
        sendStatus();
        updateTrayMenu();
        resolve();
      },
      onStop: () => {
        serverStarted = false;
        child = null;
        sendStatus();
        updateTrayMenu();
      },
      onError: () => {
        serverStarted = false;
        child = null;
        resolve();
      },
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) { resolve(); return; }
    child.on("exit", () => {
      serverStarted = false;
      child = null;
      sendStatus();
      updateTrayMenu();
      resolve();
    });
    child.kill();
  });
}

async function restartServer() {
  await stopServer();
  startServer();
}

registerIpcHandlers({
  get serverStarted() { return serverStarted; },
  get serverPort() { return serverPort; },
  startServer,
  stopServer,
  restartServer,
  openConfigDir: () => openDir(getConfigDir()),
});

function createTray() {
  const icon = (() => {
    for (const size of [16, 32, 64]) {
      const p = path.join(__dirname, "..", "assets", `icon-${size}.png`);
      try {
        const i = nativeImage.createFromPath(p);
        if (!i.isEmpty()) return i.resize({ width: 16, height: 16 });
      } catch {}
    }
    return nativeImage.createEmpty();
  })();

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

app.whenReady().then(() => {
  createTray();
  createWindow();
  startServer();
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  stopServer();
});
