import { expect, type Page, test } from "@playwright/test";

import tools from "../src/data/tool-reference.json";

const base = process.env.BASE_PATH ?? "/";
const categories = [
  "workspaces",
  "files",
  "configuration",
  "code-intelligence",
  "indexing",
];

async function holdTOCObservations(page: Page) {
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    let holding = true;
    let scrollEnds = 0;
    let hashChanges = 0;
    document.addEventListener("scrollend", () => scrollEnds++);
    window.addEventListener("hashchange", () => hashChanges++);
    const pending: (() => void)[] = [];
    const select: ((id: string) => void)[] = [];
    const control = {
      get queued() {
        return pending.length;
      },
      get scrollEnds() {
        return scrollEnds;
      },
      get hashChanges() {
        return hashChanges;
      },
      select(id: string) {
        for (const publish of select) publish(id);
      },
      deliver() {
        for (const deliver of pending.splice(0)) deliver();
      },
      release() {
        holding = false;
        control.deliver();
      },
    };
    Object.assign(window, { __tocObserver: control });
    window.IntersectionObserver = class extends NativeObserver {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        super((entries, observer) => {
          if (holding && options?.threshold === 0.9) {
            pending.push(() => callback(entries, observer));
          } else callback(entries, observer);
        }, options);
        if (options?.threshold === 0.9) {
          select.push((id) => {
            const entries = Array.from(
              document.querySelectorAll("h2[id], h3[id]"),
              (target): IntersectionObserverEntry => {
                const bounds = target.getBoundingClientRect();
                return {
                  target,
                  boundingClientRect: bounds,
                  intersectionRect: bounds,
                  rootBounds: new DOMRect(0, 0, innerWidth, innerHeight),
                  intersectionRatio: target.id === id ? 1 : 0,
                  isIntersecting: target.id === id,
                  time: 0,
                };
              },
            );
            callback(entries, this);
          });
        }
      }
    };
  });
}

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
  const rootConstraints = page.locator('[id="parameters-file_patch-$"]');
  await rootConstraints.getByRole("button").click();
  await expect(rootConstraints).toContainText(
    "Unknown properties are rejected",
  );
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

test("legacy tool TOC keeps combined tool headings and nests subsections beneath their parent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "docs/tools/file-system");
  const toc = page.getByRole("navigation", { name: "Tools on this page" });
  const toolLinks = toc.locator(":scope > ul > li > a");
  await expect(toolLinks).toHaveCount(6);
  await expect(toolLinks).toContainText([
    "file_hash",
    "file_capabilities and file_read",
    "file_write",
    "file_patch",
    "file_rename",
    "file_chattr and file_delete",
  ]);
  const patch = toc.locator(":scope > ul > li").filter({
    has: page.locator('a[href="#file_patch"]'),
  });
  const subsection = patch
    .getByRole("list", { name: "Tool subsections" })
    .getByRole("link", { name: "Optional SQL candidate validation" });
  await subsection.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#optional-sql-candidate-validation$/);
  await expect(subsection).toHaveAttribute("aria-current", "location");
  await expect(
    page.locator("h3#optional-sql-candidate-validation"),
  ).toBeInViewport();
});

test("tool TOC preserves fragment selection across delayed observations and history", async ({
  page,
}) => {
  await holdTOCObservations(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + "docs/tools/file-system#file_patch");
  const toc = page.getByRole("navigation", { name: "Tools on this page" });
  const patch = toc.locator('a[href="#file_patch"]');
  const subsection = toc.getByRole("link", {
    name: "Optional SQL candidate validation",
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as Window & {
              __tocObserver: { queued: number };
            }
          ).__tocObserver.queued,
      ),
    )
    .toBeGreaterThan(0);
  await expect(patch).toHaveAttribute("aria-current", "location");
  await expect(patch).toHaveAttribute("data-active", "true");

  await subsection.evaluate((link) =>
    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    }),
  );
  await subsection.click();
  await expect(page).toHaveURL(/#file_patch$/);
  await expect(patch).toHaveAttribute("aria-current", "location");
  await subsection.evaluate((link) => {
    window.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    link.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
  });
  await expect(page).toHaveURL(/#file_patch$/);
  await expect(patch).toHaveAttribute("aria-current", "location");

  await subsection.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#optional-sql-candidate-validation$/);
  await expect(subsection).toHaveAttribute("aria-current", "location");
  await expect(subsection).toHaveAttribute("data-active", "true");
  await page.evaluate(() =>
    (
      window as unknown as Window & {
        __tocObserver: { deliver(): void };
      }
    ).__tocObserver.deliver(),
  );
  await expect(subsection).toHaveAttribute("aria-current", "location");
  await expect(subsection).toHaveAttribute("data-active", "true");

  const beforeBack = await page.evaluate(() => {
    const control = (
      window as unknown as Window & {
        __tocObserver: { hashChanges: number; select(id: string): void };
      }
    ).__tocObserver;
    control.select("optional-sql-candidate-validation");
    return control.hashChanges;
  });
  await page.goBack();
  await expect(page).toHaveURL(/#file_patch$/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as Window & {
              __tocObserver: { hashChanges: number };
            }
          ).__tocObserver.hashChanges,
      ),
    )
    .toBeGreaterThan(beforeBack);
  const restored = await page.evaluate(() => {
    document
      .getElementById("file_patch")!
      .scrollIntoView({ behavior: "instant" });
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const scroller = document.scrollingElement!;
    const before = scroller.scrollTop;
    document.dispatchEvent(new Event("scroll"));
    return { before, after: scroller.scrollTop };
  });
  expect(restored.after).toBe(restored.before);
  await expect(patch).toHaveAttribute("aria-current", "location");
  await expect(patch).toHaveAttribute("data-active", "true");
  await page.goForward();
  await expect(page).toHaveURL(/#optional-sql-candidate-validation$/);
  await expect(subsection).toHaveAttribute("aria-current", "location");
  await expect(subsection).toHaveAttribute("data-active", "true");

  await page.evaluate(() =>
    (
      window as unknown as Window & {
        __tocObserver: { release(): void };
      }
    ).__tocObserver.release(),
  );
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -100_000);
  const first = toc.locator('a[href="#file_hash"]');
  await expect(first).toHaveAttribute("aria-current", "location");
  await expect(first).toHaveAttribute("data-active", "true");
  await expect(subsection).not.toHaveAttribute("aria-current", "location");
  await expect(subsection).toHaveAttribute("data-active", "false");

  await subsection.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#optional-sql-candidate-validation$/);
  await expect(subsection).toHaveAttribute("aria-current", "location");
  await expect(subsection).toHaveAttribute("data-active", "true");
  await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
});

test("tool TOC releases a settled initial fragment on the first manual scroll", async ({
  page,
}) => {
  await holdTOCObservations(page);
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await scriptsReady;
    await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const heading = page.locator("h2#file_patch");
  try {
    await page.goto(base + "docs/tools/file-system#file_patch", {
      waitUntil: "commit",
    });
    await expect(heading).toBeInViewport();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as Window & {
                __tocObserver: { scrollEnds: number };
              }
            ).__tocObserver.scrollEnds,
        ),
      )
      .toBeGreaterThan(0);
  } finally {
    releaseScripts();
    await page.unrouteAll({ behavior: "wait" });
  }
  const toc = page.getByRole("navigation", { name: "Tools on this page" });
  const patch = toc.locator('a[href="#file_patch"]');
  await expect(patch).toHaveAttribute("aria-current", "location");
  const initialTop = await heading.evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -40);
  await expect
    .poll(() =>
      heading.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeGreaterThan(initialTop);
  await expect(heading).toBeInViewport();
  await page.evaluate(() =>
    (
      window as unknown as Window & {
        __tocObserver: { select(id: string): void };
      }
    ).__tocObserver.select("file_write"),
  );
  const observed = toc.locator('a[href="#file_write"]');
  await expect(observed).toHaveAttribute("aria-current", "location");
  await expect(observed).toHaveAttribute("data-active", "true");
  await expect(patch).not.toHaveAttribute("aria-current", "location");
  await expect(patch).toHaveAttribute("data-active", "false");
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
