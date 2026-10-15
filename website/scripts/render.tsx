import {
  createRequestHandler,
  renderRouterToString,
  RouterServer,
} from "@tanstack/react-router/ssr/server";

import { getRouter } from "../src/router";

export function renderPage(request: Request): Promise<Response> {
  return createRequestHandler({ request, createRouter: getRouter })(
    ({ router, responseHeaders }) =>
      renderRouterToString({
        router,
        responseHeaders,
        children: <RouterServer router={router} />,
      }),
  );
}
