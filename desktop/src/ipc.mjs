import { ipcMain } from "electron";

export function registerIpcHandlers(ctx) {
  ipcMain.handle("get-status", () => ({
    running: ctx.serverStarted,
    port: ctx.serverPort,
  }));

  ipcMain.handle("start-server", async () => {
    await ctx.startServer();
    return { running: ctx.serverStarted, port: ctx.serverPort };
  });

  ipcMain.handle("stop-server", async () => {
    await ctx.stopServer();
    return { running: ctx.serverStarted, port: ctx.serverPort };
  });

  ipcMain.handle("restart-server", async () => {
    await ctx.restartServer();
    return { running: ctx.serverStarted, port: ctx.serverPort };
  });

  ipcMain.handle("open-config-dir", () => {
    ctx.openConfigDir();
  });
}
