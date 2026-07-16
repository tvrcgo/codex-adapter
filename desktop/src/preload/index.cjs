const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  getLogs: () => ipcRenderer.invoke("get-logs"),
  startServer: () => ipcRenderer.invoke("start-server"),
  stopServer: () => ipcRenderer.invoke("stop-server"),
  restartServer: () => ipcRenderer.invoke("restart-server"),
  openConfigDir: () => ipcRenderer.invoke("open-config-dir"),
  onServerStatus: (cb) => { ipcRenderer.on("server-status", (_e, s) => cb(s)); },
  onServerLog: (cb) => { ipcRenderer.on("server-log", (_e, l) => cb(l)); },
});