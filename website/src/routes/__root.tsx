import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type { ReactNode } from "react";

import StaticSearchDialog from "@/components/search";
import { basePath } from "@/lib/deployment";

export const Route = createRootRoute({
  component: RootComponent,
  head: () => ({
    links: [
      { href: basePath + "assets/app.css", rel: "stylesheet" },
      { href: basePath + "logo.svg", rel: "icon", type: "image/svg+xml" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      {
        content:
          "A zero-trust MCP boundary for structural code intelligence and deterministic, guarded repository writes.",
        name: "description",
      },
      { title: "AST MCP — inspect structurally, write safely" },
    ],
  }),
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ SearchDialog: StaticSearchDialog }}>
          {children}
        </RootProvider>
        <Scripts />
        {process.env.NODE_ENV === "production" && (
          <script type="module" src={basePath + "assets/client.js"} />
        )}
      </body>
    </html>
  );
}
