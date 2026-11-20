import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

import {
  hostedReleasePageVersion,
  prepareBenchmarkedReleasePages,
} from "./release-benchmark-pages.ts";

const releaseDirectory = "website/content/docs/releases";

function github(args: string[]): Buffer {
  const { exitCode, stdout, stderr } = Bun.spawnSync(["gh", "api", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (exitCode !== 0)
    throw new Error("GitHub API failed: " + stderr.toString());
  return stdout;
}

async function hydrateReleasePages() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    !repository ||
    !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repository) ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    throw new Error("Benchmark hydration requires a GitHub Actions checkout");
  const names = (await readdir(releaseDirectory)).filter(
    hostedReleasePageVersion,
  );
  if (names.length === 0) return;
  const prefix = "repos/" + repository;
  const pages: unknown = JSON.parse(
    github([
      "--paginate",
      "--slurp",
      prefix + "/releases?per_page=100",
    ]).toString(),
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray))
    throw new Error("Invalid GitHub release pages");
  const authored = new Map<string, string>();
  for (const name of names)
    authored.set(
      name,
      await Bun.file(path.join(releaseDirectory, name)).text(),
    );
  const updates = await prepareBenchmarkedReleasePages(authored, pages.flat(), {
    async tagCommit(tag) {
      return github([prefix + "/commits/" + tag, "--jq", ".sha"])
        .toString()
        .trim();
    },
    async asset(id) {
      return github([
        prefix + "/releases/assets/" + id,
        "--header",
        "Accept: application/octet-stream",
      ]);
    },
  });
  for (const [name, content] of updates) {
    const destination = path.join(releaseDirectory, name);
    if (content === null) await unlink(destination);
    else await Bun.write(destination, content);
  }
}

if (import.meta.main) await hydrateReleasePages();
