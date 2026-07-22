import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center px-6 text-center">
      <p className="mb-3 font-mono text-sm text-blue-600 dark:text-cyan-400">
        path boundary / not found
      </p>
      <h1 className="text-4xl font-semibold tracking-tight">
        This node is outside the tree.
      </h1>
      <p className="mt-4 text-fd-muted-foreground">
        Return to the documentation and continue from a known root.
      </p>
      <Link
        className="mt-8 rounded-full bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition hover:opacity-90"
        params={{ _splat: "" }}
        to="/docs/$"
      >
        Open the docs
      </Link>
    </main>
  );
}
