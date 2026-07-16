import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: "src/main/index.mjs" },
        external: [
          "electron",
          /^node:/,
        ],
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: "src/preload/index.cjs" },
        output: { format: "cjs", entryFileNames: "[name].js" },
        external: ["electron"],
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: { index: "src/renderer/index.html" },
      },
    },
  },
});