import { normalizeBasePath } from "../src/lib/base-path";
import { source } from "../src/lib/source";
const pageTree = await source.serializePageTree(source.getPageTree());
const pages = source.getPages().map((page) => ({
  url: page.url,
  path: page.path,
  title: page.data.title,
  description: page.data.description ?? "",
}));
await Bun.write(
  ".source/site.json",
  JSON.stringify({
    basePath: normalizeBasePath(process.env.BASE_PATH ?? "/"),
    pageTree,
    pages,
  }),
);

const { createFromSource } = await import("fumadocs-core/search/server");
const search = await createFromSource(source, {
  language: "english",
}).staticGET();
await Bun.write(".source/search.json", await search.text());
