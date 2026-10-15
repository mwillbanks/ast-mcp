import { createRouter } from "@tanstack/react-router";

import { NotFound } from "@/components/not-found";
import { basePath } from "@/lib/deployment";

import { Route as rootRoute } from "./routes/__root";
import { Route as docsRoute } from "./routes/docs/$";
import { Route as homeRoute } from "./routes/index";

const routeTree = rootRoute.addChildren([homeRoute, docsRoute]);

export function getRouter() {
  return createRouter({
    basepath: basePath.replace(/\/$/, "") || "/",
    defaultNotFoundComponent: NotFound,
    defaultPreload: "intent",
    routeTree,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
