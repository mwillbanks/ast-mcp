import { publishNpmRelease } from "./npm-publication.ts";

await publishNpmRelease(Bun.argv.slice(2), {
  fetch: (url) =>
    fetch(url, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    }),
  publish: (command) =>
    Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }).exited,
  delay: Bun.sleep,
});
