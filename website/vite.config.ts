import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const configuredBase = process.env.VITE_BASE_PATH ?? "/";
const base = configuredBase.endsWith("/")
  ? configuredBase
  : `${configuredBase}/`;

export default defineConfig({
  base,
  plugins: [
    mdx(),
    tailwindcss(),
    tanstackStart({
      pages: [{ path: "/docs" }, { path: "/api/search" }],
      spa: {
        enabled: true,
        prerender: {
          crawlLinks: true,
          enabled: true,
        },
      },
    }),
    react(),
    nitro(),
  ],
  resolve: { tsconfigPaths: true },
  server: {
    fs: {
      allow: [resolve(import.meta.dirname, "..")],
    },
    port: 3000,
  },
});
