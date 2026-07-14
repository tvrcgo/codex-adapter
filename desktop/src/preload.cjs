const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  startServer: () => ipcRenderer.invoke("start-server"),
  stopServer: () => ipcRenderer.invoke("stop-server"),
  restartServer: () => ipcRenderer.invoke("restart-server"),
  openConfigDir: () => ipcRenderer.invoke("open-config-dir"),
  onServerStatus: (callback) => {
    ipcRenderer.on("server-status", (_event, status) => callback(status));
  },
});
