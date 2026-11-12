import { defineConfig, defineDocs } from "fumadocs-mdx/config";

import { remarkMermaid } from "./scripts/remark-mermaid";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMermaid],
  },
});
