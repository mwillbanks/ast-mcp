import type { BunPlugin } from "bun";

/** Defer a circular import read in TanStack's development-only HMR hook. */
export function adaptRouterDevelopmentHooks(source: string): string {
  return source.replace(
    "RouterCore.prototype._replaceRouteChunk = replaceRouteChunk;",
    "RouterCore.prototype._replaceRouteChunk = function(...args) { return replaceRouteChunk.apply(this, args); };",
  );
}

export const routerCompatibilityPlugin: BunPlugin = {
  name: "tanstack-bun-development-compatibility",
  setup(build) {
    build.onLoad(
      { filter: /@tanstack\/router-core\/dist\/esm\/router\.js$/ },
      async (args) => ({
        contents: adaptRouterDevelopmentHooks(await Bun.file(args.path).text()),
        loader: "js",
      }),
    );
  },
};
