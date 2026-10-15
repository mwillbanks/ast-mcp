import { RouterProvider } from "@tanstack/react-router";
import { createRoot, type Root } from "react-dom/client";

import "../.source/app.css";
import { getRouter } from "./router";

const root: Root = import.meta.hot.data.root ?? createRoot(document);
const router: ReturnType<typeof getRouter> =
  import.meta.hot.data.router ?? getRouter();
root.render(<RouterProvider router={router} />);
import.meta.hot.data.root = root;
import.meta.hot.data.router = router;
import.meta.hot.accept(() => {
  void router.invalidate();
});
