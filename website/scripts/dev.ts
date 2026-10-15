import { watch, type FSWatcher } from "node:fs";

import { normalizeBasePath } from "../src/lib/base-path";

const basePath = normalizeBasePath(process.env.BASE_PATH ?? "/");
process.env.NODE_ENV = "development";
let css: ReturnType<typeof Bun.spawn> | undefined;
let generationChild: ReturnType<typeof Bun.spawn> | undefined;
let watcher: FSWatcher | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = Promise.resolve();
let closing = false;

async function close(code: number) {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  watcher?.close();
  server?.stop(true);
  generationChild?.kill();
  css?.kill();
  await Promise.all([css?.exited, generationChild?.exited]);
  process.exit(code);
}
process.once("SIGINT", () => {
  void close(0);
});
process.once("SIGTERM", () => {
  void close(0);
});

try {
  await import("./generate");
  css = Bun.spawn(
    [
      process.execPath,
      "./node_modules/.bin/tailwindcss",
      "-i",
      "./src/styles/app.css",
      "-o",
      "./.source/app.css",
      "--watch=always",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  for (
    let attempt = 0;
    attempt < 100 && !(await Bun.file(".source/app.css").exists());
    attempt++
  ) {
    if (css.exitCode !== null)
      throw new Error("Tailwind exited before creating CSS");
    await Bun.sleep(50);
  }
  if (!(await Bun.file(".source/app.css").exists()))
    throw new Error("Tailwind did not create CSS");
  const { default: html } = await import("../src/dev.html");
  watcher = watch("content/docs", { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      generation = generation.then(async () => {
        if (closing) return;
        generationChild = Bun.spawn([process.execPath, "scripts/generate.ts"], {
          stdout: "inherit",
          stderr: "inherit",
        });
        if ((await generationChild.exited) !== 0 && !closing)
          console.error("Documentation regeneration failed");
        generationChild = undefined;
      });
    }, 100);
  });
  server = Bun.serve({
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
    development: { hmr: true, console: true },
    routes: {
      [basePath + "assets/app.css"]: () =>
        new Response(Bun.file(".source/app.css")),
      [basePath + "logo.svg"]: () => new Response(Bun.file("../logo.svg")),
      [basePath + "api/search"]: () =>
        new Response(Bun.file(".source/search.json")),
      "/*": html,
    },
    fetch() {
      return new Response("Not found", { status: 404 });
    },
  });
  console.log("Development listening on " + server.url);
} catch (error) {
  console.error(error);
  await close(1);
}
