import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeBasePath } from "../src/lib/base-path";
import mdxPlugin from "./mdx-plugin";

const basePath = normalizeBasePath(process.env.BASE_PATH ?? "/");
process.env.NODE_ENV = "production";
await import("./generate");
const output = join(process.cwd(), ".output/public");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
await cp("public", output, { recursive: true });
await cp("../logo.svg", join(output, "logo.svg"));

const css = Bun.spawn(
  [
    process.execPath,
    "./node_modules/.bin/tailwindcss",
    "-i",
    "./src/styles/app.css",
    "-o",
    join(output, "assets/app.css"),
    "--minify",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await css.exited) !== 0) throw new Error("Tailwind compilation failed");
const result = await Bun.build({
  entrypoints: ["./src/client.tsx"],
  outdir: join(output, "assets"),
  target: "browser",
  splitting: true,
  minify: true,
  naming: {
    entry: "[name].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
  publicPath: basePath + "assets/",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [mdxPlugin],
});
if (!result.success)
  throw new AggregateError(result.logs, "Browser bundling failed");
const { renderPage } = await import("./render");
const { source } = await import("../src/lib/source");
const pages = ["/", ...source.getPages().map((page) => page.url)];
for (const path of pages) {
  const response = await renderPage(
    new Request(
      "http://localhost" +
        basePath.replace(/\/$/, "") +
        (path === "/" ? "/" : path),
    ),
  );
  if (response.status !== 200)
    throw new Error("Prerender failed: " + path + " (" + response.status + ")");
  const destination = join(output, path, "index.html");
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(destination, await response.text());
}
const missing = await renderPage(
  new Request("http://localhost" + basePath + "missing-page"),
);
if (missing.status !== 404)
  throw new Error("Missing page must render HTTP 404");
await Bun.write(join(output, "404.html"), await missing.text());
const { createFromSource } = await import("fumadocs-core/search/server");
await mkdir(join(output, "api/search"), { recursive: true });
const search = await createFromSource(source, {
  language: "english",
}).staticGET();
await Bun.write(join(output, "api/search/index.html"), await search.text());
console.log("Built " + pages.length + " prerendered pages at " + basePath);
