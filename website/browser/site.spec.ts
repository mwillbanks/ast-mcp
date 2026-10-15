import { expect, test } from "@playwright/test";

const base = process.env.BASE_PATH ?? "/";

test("prerendered pages hydrate, navigate, search, and retain deployment paths", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const installation = base + "docs/getting-started/installation";
  const staticPage = await request.get(installation);
  expect(staticPage.status()).toBe(200);
  expect(await staticPage.text()).toContain("Install the MCP server");
  await page.goto(base);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Inspect structurally.",
  );
  await page.evaluate(() => Reflect.set(window, "astMcpNavigationProof", true));
  await page.getByRole("link", { name: "Install ast-mcp" }).click();
  expect(
    await page.evaluate(() => Reflect.get(window, "astMcpNavigationProof")),
  ).toBe(true);
  await expect(page).toHaveURL(new RegExp(installation + "$"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Installation",
  );
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Inspect structurally.",
  );
  await page.goto(installation);
  await expect(page).toHaveTitle("Installation | AST MCP");
  await expect(page.locator('img[alt="AST MCP"]').first()).toHaveJSProperty(
    "complete",
    true,
  );
  await page
    .getByRole("button", { name: /search/i })
    .first()
    .click();
  const search = page.getByRole("dialog").getByRole("combobox");
  await search.fill("root isolation");
  await expect(
    page.getByRole("dialog").getByRole("option").first(),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("option").first().click();
  await expect(page).toHaveURL(
    new RegExp(base + "docs/concepts/root-isolation$"),
  );
  const theme = page.getByRole("button", { name: /theme/i }).first();
  await expect(theme).toBeVisible();
  const previousTheme = await page.locator("html").getAttribute("class");
  await theme.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "class",
    previousTheme ?? "",
  );
  const missing = await page.goto(base + "missing-page");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "outside the tree",
  );
  expect(errors).toEqual([]);
});

test("every generated documentation URL has HTML and a static search index", async ({
  request,
}) => {
  const site = await Bun.file(".source/site.json").json();
  for (const page of site.pages) {
    const response = await request.get(base.replace(/\/$/, "") + page.url);
    expect(response.status(), page.url).toBe(200);
    expect(await response.text()).toContain(page.title);
  }
  const search = await request.get(base + "api/search");
  expect(search.status()).toBe(200);
  expect(await search.json()).toBeTruthy();
});
