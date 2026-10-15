# Documentation website

Use Bun 1.4.3 or newer. Install the website dependencies with `bun install`.

## Commands

- `bun run dev`: start Bun's HTML development server and Tailwind watcher on port 3000.
- `bun run build`: generate collections, bundle browser modules, and prerender the website.
- `bun run preview`: serve the generated website on port 3000.
- `bun run typecheck`: generate collection types and check them with `bun check`.
- `bun run test`: validate deployment path handling.
- `bun run test:browser`: build and test root and project deployments with Chromium.

Set `BASE_PATH=/ast-mcp/` for GitHub Pages project deployments. Use the same value for build and preview.

Set `PORT` to change either server's port. Both servers bind to loopback unless `HOST` is specified.

Install the declared browser dependency before browser validation:

```sh
bun run --bun playwright install chromium
bun run test:browser
```

## Build architecture

Fumadocs generates explicit collection imports through its supported generation helper.
Its native Bun plugin compiles MDX for server execution and browser bundles.
A small resolver handles collection-qualified imports from the collection generator.
A development adapter defers TanStack's circular HMR import read until its hook executes.
It preserves the upstream hook and leaves installed dependencies unchanged.

TanStack Router defines the home and documentation routes explicitly.
Its SSR handler prerenders the home page, each documentation URL, and the missing-page document.
The browser hydrates the same route tree and preloads documentation modules before navigation.

Static page metadata replaces server-function caches and records the configured deployment base.
Both server rendering and browser navigation use that generated base.
The search endpoint contains Fumadocs' static Orama index.
Production output remains `.output/public`, including `.nojekyll`.

The development server uses Bun HTML routes and React Fast Refresh.
Tailwind CLI watches styles, and collection generation watches documentation additions and removals.
Browser tests use disposable copies, verify retained React state, and stop their processes after validation.
