import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

test("native Bun refresh preserves React state and reloads CSS and MDX", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const base = process.env.BASE_PATH ?? "/";
  const temporary = await mkdtemp(join(tmpdir(), "ast-mcp-docs-"));
  const fixture = join(temporary, "website");
  await mkdir(fixture, { recursive: true });
  for (const path of [
    "src",
    "scripts",
    "content",
    "public",
    "source.config.ts",
    "tsconfig.json",
    "bunfig.toml",
    "package.json",
  ]) {
    await cp(path, join(fixture, path), { recursive: true });
  }
  await symlink(resolve("node_modules"), join(fixture, "node_modules"), "dir");
  await cp("../logo.svg", join(temporary, "logo.svg"));
  const homeFile = join(fixture, "src/components/home.tsx");
  let home = await readFile(homeFile, "utf8");
  home =
    'import { useState } from "react";\n' +
    home
      .replace(
        "export default function Home() {",
        "export default function Home() { const [count, setCount] = useState(0);",
      )
      .replace(
        "<main className=",
        "<button onClick={() => setCount(count + 1)}>HMR count: {count}</button><main className=",
      );
  await writeFile(homeFile, home);
  const port = base === "/" ? 4273 : 4274;
  const child = Bun.spawn([process.execPath, "scripts/dev.ts"], {
    cwd: fixture,
    env: { ...process.env, BASE_PATH: base, PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  let diagnostics = "";
  const errors = (async () => {
    for await (const chunk of child.stderr)
      diagnostics += new TextDecoder().decode(chunk);
  })();
  try {
    const url = "http://127.0.0.1:" + port + base;
    await expect(async () => {
      if (child.exitCode !== null) throw new Error(diagnostics);
      expect((await fetch(url)).status).toBe(200);
    }).toPass({ timeout: 15_000 });
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: "HMR count: 0" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "HMR count: 0" }).click();
    await expect(
      page.getByRole("button", { name: "HMR count: 1" }),
    ).toBeVisible();
    await writeFile(
      homeFile,
      home.replace("Inspect structurally.", "Inspect dynamically."),
    );
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Inspect dynamically.",
    );
    await expect(
      page.getByRole("button", { name: "HMR count: 1" }),
    ).toBeVisible();
    const cssFile = join(fixture, "src/styles/app.css");
    await writeFile(
      cssFile,
      (await readFile(cssFile, "utf8")) + "\nbody { --hmr-proof: updated; }\n",
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.body)
            .getPropertyValue("--hmr-proof")
            .trim(),
        ),
      )
      .toBe("updated");
    const mdxFile = join(fixture, "content/docs/index.mdx");
    await writeFile(
      mdxFile,
      (await readFile(mdxFile, "utf8")) + "\nDocumentation refresh proof.\n",
    );
    await page.goto("http://127.0.0.1:" + port + base + "docs");
    await expect(page.getByText("Documentation refresh proof.")).toBeVisible();
    const added = join(fixture, "content/docs/guides/refresh-proof.mdx");
    await writeFile(
      added,
      "---\ntitle: Added documentation proof\ndescription: Generated during a bounded browser test.\n---\n\nNew collection entry proof.\n",
    );
    await expect(async () => {
      await page.goto(
        "http://127.0.0.1:" + port + base + "docs/guides/refresh-proof",
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Added documentation proof",
      );
    }).toPass({ timeout: 10_000 });
    await rm(added);
    await expect(async () => {
      await page.goto(
        "http://127.0.0.1:" + port + base + "docs/guides/refresh-proof",
      );
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "outside the tree",
      );
    }).toPass({ timeout: 10_000 });
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await Promise.race([errors, Bun.sleep(1000)]);
    await rm(temporary, { recursive: true, force: true });
  }
});
