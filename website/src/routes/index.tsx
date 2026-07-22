import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Binary,
  GitBranch,
  LockKeyhole,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import logoUrl from "../../../logo.svg?url";
import { Brand } from "@/components/brand";
import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/")({ component: Home });

const highlights = [
  {
    description:
      "Native AST maps, symbol context, callers, dependencies, impact, and structural search without whole-file source dumps.",
    icon: ScanSearch,
    title: "Structural intelligence",
  },
  {
    description:
      "Every path is root-bounded, symlink-aware, and validated before code intelligence or filesystem work begins.",
    icon: ShieldCheck,
    title: "Zero-trust boundaries",
  },
  {
    description:
      "Fresh hashes, exact-match rewrites, deterministic locks, formatting, and atomic replacement make writes reviewable.",
    icon: LockKeyhole,
    title: "Guarded mutation",
  },
];

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="home-shell flex-1 overflow-hidden">
        <section className="relative mx-auto grid max-w-[92rem] grid-cols-[minmax(0,1fr)] gap-12 px-6 pb-20 pt-20 lg:grid-cols-[1.04fr_0.96fr] lg:px-12 lg:pb-28 lg:pt-28">
          <div className="hero-glow" aria-hidden="true" />
          <div className="relative z-10 min-w-0">
            <div className="mb-8 inline-flex rounded-full border border-blue-500/20 bg-blue-500/8 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:text-cyan-300">
              AST intelligence × deterministic writes
            </div>
            <div className="mb-8 lg:hidden">
              <Brand />
            </div>
            <h1 className="max-w-4xl text-balance text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-7xl lg:text-[5.45rem]">
              Inspect structurally.
              <span className="hero-gradient block">Write safely.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground sm:text-xl">
              ast-mcp gives coding agents a zero-trust repository boundary with
              native code intelligence, state-machine-enforced edits, and atomic
              filesystem operations.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link
                className="group inline-flex items-center justify-center gap-2 rounded-full bg-fd-primary px-6 py-3 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-blue-500/15 transition hover:-translate-y-0.5 hover:shadow-blue-500/25"
                params={{ _splat: "getting-started/installation" }}
                to="/docs/$"
              >
                Install ast-mcp
                <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
              </Link>
              <a
                className="inline-flex items-center justify-center gap-2 rounded-full border border-fd-border bg-fd-card/70 px-6 py-3 text-sm font-semibold backdrop-blur transition hover:border-violet-500/40 hover:bg-fd-accent"
                href="https://github.com/mwillbanks/ast-mcp"
              >
                View on GitHub
              </a>
            </div>
          </div>

          <div className="relative z-10 flex min-w-0 items-center justify-center">
            <div className="logo-orbit" aria-hidden="true">
              <div className="orbit-ring orbit-ring-one" />
              <div className="orbit-ring orbit-ring-two" />
              <img alt="" className="hero-logo" src={logoUrl} />
              <span className="orbit-node node-search">
                <ScanSearch />
              </span>
              <span className="orbit-node node-branch">
                <GitBranch />
              </span>
              <span className="orbit-node node-lock">
                <LockKeyhole />
              </span>
              <span className="orbit-node node-binary">
                <Binary />
              </span>
            </div>
          </div>
        </section>

        <section className="border-y border-fd-border/70 bg-fd-card/35">
          <div className="mx-auto grid max-w-[92rem] gap-px px-6 py-6 md:grid-cols-3 lg:px-12">
            {highlights.map(({ description, icon: Icon, title }) => (
              <article className="feature-card p-6 sm:p-8" key={title}>
                <Icon className="mb-5 size-6 text-blue-600 dark:text-cyan-400" />
                <h2 className="text-lg font-semibold tracking-tight">
                  {title}
                </h2>
                <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
                  {description}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[92rem] px-6 py-20 lg:px-12 lg:py-28">
          <div className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <p className="mb-3 text-sm font-semibold text-blue-700 dark:text-cyan-300">
                Follow the boundary
              </p>
              <h2 className="max-w-2xl text-3xl font-semibold tracking-[-0.035em] sm:text-5xl">
                From first install to verified agent workflow.
              </h2>
            </div>
            <p className="max-w-md text-sm leading-6 text-fd-muted-foreground">
              Connect your host, choose the smallest intelligence surface, then
              make guarded writes with fresh state and explicit intent.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <JourneyCard
              icon={Sparkles}
              label="01 / Connect"
              slug="getting-started/installation"
              text="Install the MCP server, skill, and blocking hooks for Codex, Claude, or Copilot."
              title="Installation"
            />
            <JourneyCard
              icon={ScanSearch}
              label="02 / Inspect"
              slug="tools/code-intelligence"
              text="Map symbols, trace calls, inspect impact, and search syntax without source sprawl."
              title="Code intelligence"
            />
            <JourneyCard
              icon={LockKeyhole}
              label="03 / Change"
              slug="concepts/write-boundary"
              text="Move through hash, preview, patch, format, lock, and atomic commit."
              title="Write boundary"
            />
          </div>
        </section>
      </main>
    </HomeLayout>
  );
}

type JourneyCardProps = {
  icon: typeof Sparkles;
  label: string;
  slug: string;
  text: string;
  title: string;
};

function JourneyCard({
  icon: Icon,
  label,
  slug,
  text,
  title,
}: JourneyCardProps) {
  return (
    <Link
      className="journey-card group rounded-2xl border border-fd-border bg-fd-card p-6 transition hover:-translate-y-1 hover:border-blue-500/40 hover:shadow-xl hover:shadow-blue-950/5"
      params={{ _splat: slug }}
      to="/docs/$"
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-xs text-fd-muted-foreground">
          {label}
        </span>
        <Icon className="size-5 text-blue-600 dark:text-cyan-400" />
      </div>
      <h3 className="mt-10 text-xl font-semibold tracking-tight">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">{text}</p>
      <span className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-cyan-300">
        Read guide
        <ArrowRight className="size-4 transition group-hover:translate-x-1" />
      </span>
    </Link>
  );
}
