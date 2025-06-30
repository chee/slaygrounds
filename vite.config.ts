import { defineConfig } from "vite"
import deno from "@deno/vite-plugin"
import wasm from "vite-plugin-wasm"
import { VitePWA as pwa } from "vite-plugin-pwa"

export default defineConfig({
  plugins: [
    deno(),
    wasm(),
    pwa({
      workbox: {
        globPatterns: ["**/*"],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  worker: {
    format: "es",
    plugins: () => [deno(), wasm()],
  },
  define: {
    "process.env.NODE_DEBUG": "false",
    "process.versions.node": JSON.stringify("22.22"),
    global: "globalThis",
  },
  build: {
    outDir: "output",
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
    target: ["firefox137", "safari18", "esnext"],
    rollupOptions: { jsx: "preserve" },
  },
})
