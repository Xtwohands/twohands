import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "PORT");
  const port = Number(process.env.PORT || env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT for the local API proxy.");
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "two-hands-development-source",
        apply: "serve",
        configureServer(server) {
          const branch = execFileSync("git", ["branch", "--show-current"], {
            cwd: server.config.root,
            encoding: "utf8",
          }).trim();
          server.config.logger.info(
            `[Two Hands] ${server.config.root} (${branch || "detached HEAD"})`,
          );
        },
      },
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5175,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${port}`,
          // Keep the browser's host so API write checks match production.
          changeOrigin: false,
        },
      },
    },
    test: { include: ["tests/**/*.test.ts"] },
  };
});
