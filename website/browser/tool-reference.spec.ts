import { expect, test } from "@playwright/test";

import tools from "../src/data/tool-reference.json";

const base = process.env.BASE_PATH ?? "/";
const categories = [
  "workspaces",
  "files",
  "configuration",
  "code-intelligence",
  "indexing",
];

test("canonical tool pages prerender every registered heading and parameter table", async ({
  page,
  request,
}) => {
  const names: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const category of categories) {
    const url = base + "docs/reference/tools/" + category;
    const response = await request.get(url);
    expect(response.status()).toBe(200);
    const html = await response.text();
    await page.goto(url);
    const source = await Bun.file(
      "content/docs/reference/tools/" + category + ".mdx",
    ).text();
    const expectedNames = [...source.matchAll(/^## (\w+)$/gm)].map(
      (match) => match[1]!,
    );
    await expect(page.locator("h2")).toHaveCount(expectedNames.length);
    await expect(page.locator("h2").first()).toHaveAttribute(
      "id",
      expectedNames[0]!,
    );
    expect(
      await page
        .locator("h2")
        .evaluateAll((headings) => headings.map((heading) => heading.id)),
    ).toEqual(expectedNames);
    for (const tool of tools.filter((tool) =>
      expectedNames.includes(tool.name),
    )) {
      await expect(page.locator('h2[id="' + tool.name + '"]')).toContainText(
        tool.name,
      );
      expect(html).toContain('id="' + tool.name + '"');
      expect(html).toContain('data-tool-parameters="' + tool.name + '"');
      names.push(tool.name);
      await expect(
        page.locator('[data-tool-parameters="' + tool.name + '"]'),
      ).toBeVisible();
      if (Object.keys(tool.inputSchema.properties).length)
        await expect(
          page.locator('[id="parameters-' + tool.name + '"]'),
        ).toBeVisible();
    }
  }
  expect(names.sort()).toEqual(tools.map((tool) => tool.name));
  expect(errors).toEqual([]);
});

test("desktop tool TOC, keyboard parameters, nested alternatives, and defaults hydrate", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "docs/reference/tools/files");
  const toc = page.getByRole("navigation", { name: "Tools on this page" });
  const patchLink = toc.getByRole("link", { name: "file_patch", exact: true });
  await patchLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#file_patch$/);
  await expect(patchLink).toHaveAttribute("data-active", "true");
  await expect(patchLink).toHaveAttribute("aria-current", "location");
  const nested = page.locator(
    '[id="parameters-file_patch-files.*.expectedSha256"]',
  );
  const trigger = nested.getByRole("button");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(nested).toContainText("maxLength: 64");
  const alternative = page.locator(
    '[id="parameters-file_patch-revision[alternative 3].kind"]',
  );
  await alternative.getByRole("button").click();
  await expect(alternative).toContainText('"commit"');
  await page.goto(base + "docs/reference/tools/indexing#graph_query");
  const depth = page.locator('[id="parameters-graph_query-budget.maxDepth"]');
  await depth.getByRole("button").click();
  await expect(depth).toContainText("maximum: 1000");
  await expect(depth).toContainText("Default");
  await expect(depth).toContainText("8");
  expect(errors).toEqual([]);
});

test("mobile TOC and nested parameter controls remain usable without horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "docs/reference/tools/files");
  const tocTrigger = page.locator("[data-toc-popover-trigger]");
  await tocTrigger.click();
  await page.locator('[data-toc-popover-content] a[href="#file_read"]').click();
  await expect(page).toHaveURL(/#file_read$/);
  await expect(page.locator("h2#file_read")).toBeInViewport();
  const tuple = page.locator('[id="parameters-file_read-files[].lines"]');
  await tuple.getByRole("button").click();
  await expect(tuple).toContainText("[integer, integer]");
  await expect(
    page.locator('[id="parameters-file_read-files[].lines[0]"]'),
  ).toBeVisible();
  const viewport = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(viewport.page).toBeLessThanOrEqual(viewport.viewport);
});
