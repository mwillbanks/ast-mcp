import { postInstall } from "fumadocs-mdx/next";

await postInstall();
// Resolve generated collection aliases only after their files exist.
const child = Bun.spawn([process.execPath, "run", "scripts/generate-data.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await child.exited) !== 0)
  throw new Error("Documentation metadata generation failed");
