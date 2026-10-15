import { resolve } from "node:path";

import type { BunPlugin } from "bun";
import { createMdxPlugin } from "fumadocs-mdx/bun";

import { routerCompatibilityPlugin } from "./router-compat";

/** Resolve collection-qualified imports emitted by Fumadocs' index generator. */
const mdxPlugin: BunPlugin = {
  name: "ast-mcp-docs-mdx",
  async setup(build) {
    build.onResolve({ filter: /\.(?:mdx?|json)\?collection=/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.split("?")[0]),
    }));
    await routerCompatibilityPlugin.setup(build);
    await createMdxPlugin().setup(build);
  },
};
export default mdxPlugin;
