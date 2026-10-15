import { join, resolve, sep } from "node:path";

import { normalizeBasePath } from "../src/lib/base-path";

const root = resolve(".output/public");
const basePath = normalizeBasePath(process.env.BASE_PATH ?? "/");
Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (path !== basePath.slice(0, -1) && !path.startsWith(basePath))
      return new Response("Not found", { status: 404 });
    const relative = path.slice(basePath.length);
    const filePath = resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);
    const index = Bun.file(join(filePath, "index.html"));
    if (await index.exists()) return new Response(index);
    return new Response(Bun.file(join(root, "404.html")), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});
console.log("Preview listening");
