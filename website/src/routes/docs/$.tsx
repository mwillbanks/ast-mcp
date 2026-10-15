import { createRoute, notFound } from "@tanstack/react-router";
import browserCollections from "collections/browser";
import site from "collections/site.json";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";

import { getMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";

import { Route as rootRoute } from "../__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "docs/$",
  component: Page,
  loader: async ({ params }) => {
    const url =
      "/docs" + (params._splat ? "/" + params._splat.replace(/\/$/, "") : "");
    const page = site.pages.find((page) => page.url === url);
    if (!page) throw notFound();
    await clientLoader.preload(page.path);
    return page;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: loaderData.title + " | AST MCP" },
          { name: "description", content: loaderData.description },
        ]
      : [],
  }),
});

const clientLoader = browserCollections.docs.createClientLoader({
  component({ default: MDX, frontmatter, toc }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const { path } = Route.useLoaderData();
  const { pageTree } = useFumadocsLoader({
    pageTree: { ...site.pageTree, $fumadocs_loader: "page-tree" as const },
  });
  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Suspense>{clientLoader.useContent(path)}</Suspense>
    </DocsLayout>
  );
}
