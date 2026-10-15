import { createRoute } from "@tanstack/react-router";

import Home from "@/components/home";

import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});
