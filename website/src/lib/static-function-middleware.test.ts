import { describe, expect, test } from "bun:test";
import { createStaticCacheUrl } from "./static-function-middleware";

describe("static server-function cache URLs", () => {
  test("prefixes cache requests with the GitHub Pages project base", async () => {
    const url = await createStaticCacheUrl(
      "page-loader",
      ["getting-started", "installation"],
      "/ast-mcp/",
    );

    expect(url).toMatch(
      /^\/ast-mcp\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/,
    );
  });

  test("normalizes project and root deployments", async () => {
    const projectUrl = await createStaticCacheUrl("fn", "a/b c", "ast-mcp");
    const rootUrl = await createStaticCacheUrl("fn", { b: 2, a: 1 }, "/");

    expect(projectUrl).toMatch(
      /^\/ast-mcp\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/,
    );
    expect(rootUrl).toMatch(
      /^\/__tsr\/staticServerFnCache\/[a-f0-9]{40}\.json$/,
    );
  });
});
