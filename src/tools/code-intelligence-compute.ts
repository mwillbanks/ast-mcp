import path from "node:path";

import {
  findStructuralMatches,
  rewriteStructuralMatches,
  type SyntaxFacts,
} from "../intelligence/parser/index.ts";
import type { ToolInput, ToolName } from "./code-intelligence.ts";
export type NativeFile = { facts: SyntaxFacts; path: string; source: string };
function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}
function symbolView(file: NativeFile, root: string, includeSource = false) {
  return file.facts.symbols.map((symbol) => ({
    exported: symbol.exported,
    kind: symbol.kind,
    name: symbol.name,
    path: relative(root, file.path),
    qualifiedName: symbol.qualifiedName,
    range: {
      endLine: symbol.range.end.line + 1,
      startLine: symbol.range.start.line + 1,
    },
    ...(includeSource
      ? {
          source: file.source.slice(
            symbol.range.startCoordinate.utf16Offset,
            symbol.range.endCoordinate.utf16Offset,
          ),
        }
      : {}),
  }));
}

function symbolMatches(file: NativeFile, target: string) {
  return file.facts.symbols.filter(
    (symbol) =>
      symbol.name === target ||
      symbol.qualifiedName === target ||
      symbol.qualifiedName.endsWith(`.${target}`),
  );
}

type CallView = {
  callee: string;
  caller: string | null;
  line?: number;
  path: string;
  range?: { endLine: number; startLine: number };
};

function callsFor(
  files: NativeFile[],
  root: string,
  target: string,
  direction: "in" | "out",
  fullRange = false,
  signal?: AbortSignal,
): CallView[] {
  throwIfAborted(signal);
  const symbols = new Map(
    flatMapFilesWithAbort(files, signal, (file) =>
      file.facts.symbols.map((symbol) => {
        throwIfAborted(signal);
        return [symbol.id, symbol.qualifiedName] as const;
      }),
    ),
  );
  const symbolIds = new Set(
    flatMapFilesWithAbort(files, signal, (file) =>
      symbolMatches(file, target).map((symbol) => {
        throwIfAborted(signal);
        return symbol.id;
      }),
    ),
  );
  const views: CallView[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    for (const call of file.facts.calls) {
      throwIfAborted(signal);
      const selected =
        direction === "in"
          ? call.callee === target || call.callee.endsWith(`.${target}`)
          : call.enclosingSymbolId !== null &&
            symbolIds.has(call.enclosingSymbolId);
      if (!selected) continue;
      views.push({
        callee: call.callee,
        caller:
          call.enclosingSymbolId === null
            ? null
            : (symbols.get(call.enclosingSymbolId) ?? null),
        path: relative(root, file.path),
        ...(fullRange
          ? {
              range: {
                endLine: call.range.end.line + 1,
                startLine: call.range.start.line + 1,
              },
            }
          : { line: call.range.start.line + 1 }),
      });
    }
  }
  return views.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.line ?? left.range?.startLine ?? 0) -
        (right.line ?? right.range?.startLine ?? 0) ||
      left.callee.localeCompare(right.callee),
  );
}

function tracedCalls(
  files: NativeFile[],
  root: string,
  target: string,
  direction: "in" | "out",
  depth: number,
  fullRange: boolean,
  signal?: AbortSignal,
): CallView[] {
  const results = new Map<string, CallView>();
  let frontier = [target];
  const visited = new Set<string>();
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next = new Set<string>();
    for (const current of frontier.sort()) {
      throwIfAborted(signal);
      if (visited.has(current)) continue;
      visited.add(current);
      for (const call of callsFor(
        files,
        root,
        current,
        direction,
        fullRange,
        signal,
      )) {
        throwIfAborted(signal);
        results.set(JSON.stringify(call), call);
        const adjacent = direction === "out" ? call.callee : call.caller;
        if (adjacent && !visited.has(adjacent)) next.add(adjacent);
      }
    }
    frontier = [...next];
  }
  return [...results.values()];
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    result += character;
    bytes += next;
  }
  return result;
}

function bounded<T>(
  values: T[],
  input: ToolInput,
): { items: T[]; total: number; truncated: boolean } {
  const limit = input.limit ?? input.top_k ?? 200;
  const byteLimit = input.budget ?? Number.POSITIVE_INFINITY;
  const items: T[] = [];
  let bytes = 2;
  for (const value of values.slice(0, limit)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(value));
    const separatorBytes = items.length === 0 ? 0 : 1;
    if (bytes + itemBytes + separatorBytes > byteLimit) break;
    items.push(value);
    bytes += itemBytes + separatorBytes;
  }
  return {
    items,
    total: values.length,
    truncated: items.length < values.length,
  };
}

type ImportEdge = {
  ambiguous: boolean;
  external: boolean;
  from: string;
  to: string;
};

export type CompilerAlias = {
  hasWildcard: boolean;
  prefix: string;
  suffix: string;
  targets: string[];
};

function resolveKnownPath(
  candidate: string,
  known: readonly string[],
): string[] {
  const normalized = path.posix.normalize(candidate);
  if (path.posix.extname(normalized)) {
    return known.filter((entry) => entry === normalized);
  }
  return known.filter(
    (entry) =>
      entry === normalized ||
      entry.replace(/\.[^./]+$/u, "") === normalized ||
      entry.startsWith(`${normalized}/index.`),
  );
}

function substituteAliasWildcard(target: string, value: string): string {
  const marker = target.indexOf("*");
  if (marker < 0) return target;
  return `${target.slice(0, marker)}${value}${target.slice(marker + 1)}`;
}

function aliasCandidates(
  specifier: string,
  aliases: readonly CompilerAlias[],
): string[] {
  return aliases.flatMap((alias) => {
    if (!alias.hasWildcard) {
      return specifier === alias.prefix ? alias.targets : [];
    }
    if (
      !specifier.startsWith(alias.prefix) ||
      !specifier.endsWith(alias.suffix)
    )
      return [];
    const captureStart = alias.prefix.length;
    const captureEnd = specifier.length - alias.suffix.length;
    if (captureEnd < captureStart) return [];
    const value = specifier.slice(captureStart, captureEnd);
    return alias.targets.map((target) =>
      substituteAliasWildcard(target, value),
    );
  });
}

async function importGraph(
  files: NativeFile[],
  root: string,
  signal?: AbortSignal,
  aliases: CompilerAlias[] = [],
): Promise<ImportEdge[]> {
  const known = files.map((file) => relative(root, file.path)).sort();
  const raw = files.flatMap((file) => {
    throwIfAborted(signal);
    const from = relative(root, file.path);
    return [
      ...file.facts.imports.map((entry) => ({
        from,
        source: entry.source,
      })),
      ...file.facts.exports
        .filter(
          (entry): entry is typeof entry & { source: string } =>
            entry.source !== null,
        )
        .map((entry) => ({ from, source: entry.source })),
    ];
  });
  const edges = new Map<string, ImportEdge>();
  for (const edge of raw) {
    throwIfAborted(signal);
    const candidates = edge.source.startsWith(".")
      ? [
          path.posix.normalize(
            path.posix.join(path.posix.dirname(edge.from), edge.source),
          ),
        ]
      : aliasCandidates(edge.source, aliases);
    const matches = [
      ...new Set(
        candidates.flatMap((candidate) => resolveKnownPath(candidate, known)),
      ),
    ].sort();
    if (matches.length === 0) {
      const unresolved: ImportEdge = {
        ambiguous: false,
        external: true,
        from: edge.from,
        to: edge.source,
      };
      edges.set(JSON.stringify(unresolved), unresolved);
      continue;
    }
    for (const target of matches) {
      const resolved: ImportEdge = {
        ambiguous: matches.length > 1,
        external: false,
        from: edge.from,
        to: target,
      };
      edges.set(JSON.stringify(resolved), resolved);
    }
  }
  return [...edges.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function graphCycles(
  edges: readonly ImportEdge[],
  maxCycles: number,
  signal?: AbortSignal,
): { cycles: string[]; truncated: boolean } {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.external) continue;
    const targets = adjacency.get(edge.from) ?? [];
    if (!targets.includes(edge.to)) targets.push(edge.to);
    adjacency.set(edge.from, targets.sort());
  }
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];
  const positions = new Map<string, number>();
  const cycles = new Set<string>();

  const canonicalCycle = (nodes: string[]): string => {
    const body = nodes.slice(0, -1);
    const rotations = body.map((_, index) => [
      ...body.slice(index),
      ...body.slice(0, index),
    ]);
    const canonical = rotations
      .map((rotation) => rotation.join(" -> "))
      .sort()[0];
    return `${canonical} -> ${canonical?.split(" -> ")[0] ?? ""}`;
  };

  const visit = (node: string): void => {
    throwIfAborted(signal);
    state.set(node, "active");
    positions.set(node, stack.length);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (cycles.size > maxCycles) break;
      const nextState = state.get(next);
      if (nextState === "active") {
        const index = positions.get(next) as number;
        cycles.add(canonicalCycle([...stack.slice(index), next]));
      } else if (nextState !== "done") {
        visit(next);
      }
    }
    stack.pop();
    positions.delete(node);
    state.set(node, "done");
  };

  for (const node of [...adjacency.keys()].sort()) {
    if (cycles.size > maxCycles) break;
    if (!state.has(node)) visit(node);
  }
  return {
    cycles: [...cycles].sort().slice(0, maxCycles),
    truncated: cycles.size > maxCycles,
  };
}

function flatMapFilesWithAbort<T>(
  files: readonly NativeFile[],
  signal: AbortSignal | undefined,
  transform: (file: NativeFile) => readonly T[],
): T[] {
  const result: T[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    result.push(...transform(file));
  }
  return result;
}

export async function computeNative(
  name: ToolName,
  input: ToolInput,
  files: NativeFile[],
  root: string,
  aliases: CompilerAlias[],
  signal?: AbortSignal,
) {
  if (name === "squeeze") {
    throwIfAborted(signal);
    const text = input.text ?? input.query ?? "";
    const compact = text.replace(/\s+/g, " ").trim();
    const budget = input.budget ?? 8_000;
    const boundedText = utf8Prefix(compact, budget);
    return {
      schema: "ast-mcp.squeeze.v1",
      text: boundedText,
      truncated: boundedText !== compact,
    };
  }
  if (name === "run" && input.write)
    throw Object.assign(
      new Error(
        "run write mode is replaced by hash-guarded file_patch with patchStrategy=ast",
      ),
      {
        code: "use_file_patch",
        retryable: true,
        suggestedNextCall: "file_hash then file_patch",
      },
    );
  const schema = `ast-mcp.${name}.v1`;
  if (name === "map" || name === "digest") {
    const mapped = flatMapFilesWithAbort(files, signal, (file) => [
      {
        diagnostics: file.facts.diagnostics,
        language: file.facts.languageId,
        partial: file.facts.partial,
        path: relative(root, file.path),
        symbols: symbolView(file, root).slice(
          0,
          input.max_members ?? (name === "digest" ? 50 : 200),
        ),
      },
    ]);
    const result = bounded(mapped, input);
    return {
      files: result.items,
      schema,
      total: result.total,
      truncated: result.truncated,
    };
  }
  if (name === "show") {
    const targets = new Set(
      input.symbols ?? (input.target ? [input.target] : []),
    );
    const symbols = files
      .flatMap((file) => {
        throwIfAborted(signal);
        return symbolView(file, root, true);
      })
      .filter(
        (symbol) =>
          targets.size === 0 ||
          targets.has(symbol.name) ||
          targets.has(symbol.qualifiedName),
      );
    return { schema, ...bounded(symbols, input) };
  }
  if (name === "surface")
    return {
      schema,
      ...bounded(
        files
          .flatMap((file) => {
            throwIfAborted(signal);
            return symbolView(file, root);
          })
          .filter((symbol) => symbol.exported),
        input,
      ),
    };
  if (name === "implements") {
    const target = input.target ?? "";
    const items = flatMapFilesWithAbort(files, signal, (file) =>
      [...file.facts.implementations, ...file.facts.inheritance]
        .filter(
          (relationship) =>
            relationship.targetName === target ||
            relationship.targetName.endsWith(`.${target}`),
        )
        .map((relationship) => ({
          path: relative(root, file.path),
          range: relationship.range,
          target: relationship.targetName,
        })),
    );
    return { schema, ...bounded(items, input) };
  }
  if (name === "search" || name === "find_related") {
    const query = (
      input.query ??
      input.target ??
      input.path ??
      ""
    ).toLowerCase();
    const items = files
      .flatMap((file) => {
        throwIfAborted(signal);
        return symbolView(file, root, true);
      })
      .filter(
        (symbol) =>
          symbol.name.toLowerCase().includes(query) ||
          symbol.qualifiedName.toLowerCase().includes(query) ||
          symbol.source?.toLowerCase().includes(query),
      )
      .map(({ source, ...symbol }) => ({
        ...symbol,
        snippet: source?.slice(0, 1_000),
      }));
    return { schema, ...bounded(items, input) };
  }
  if (name === "run") {
    if (!input.pattern) throw new Error("run requires pattern");
    const items: Array<Record<string, unknown>> = [];
    for (const file of files) {
      throwIfAborted(signal);
      if (!input.rewrite) {
        items.push(
          ...findStructuralMatches(
            file.source,
            file.facts.languageId,
            input.pattern as string,
          ).map((match) => ({ ...match, path: relative(root, file.path) })),
        );
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      const matches = findStructuralMatches(
        file.source,
        file.facts.languageId,
        input.pattern as string,
      );
      throwIfAborted(signal);
      const preview = rewriteStructuralMatches(
        file.source,
        file.facts.languageId,
        [
          {
            expectedMatches: matches.length,
            pattern: input.pattern as string,
            replacement: input.rewrite,
          },
        ],
      );
      throwIfAborted(signal);
      items.push(
        ...preview.edits.map((edit) => ({
          ...edit,
          path: relative(root, file.path),
        })),
      );
    }
    return { schema, ...bounded(items, input) };
  }
  const edges = await importGraph(files, root, signal, aliases);
  const visibleEdges = edges.filter((edge) => {
    throwIfAborted(signal);
    return (
      (!input.hide_external || !edge.external) &&
      (!input.hide_ambiguous || !edge.ambiguous)
    );
  });
  if (name === "graph")
    return {
      schema,
      ...bounded(visibleEdges, input),
    };
  if (name === "cycles") {
    const limit = input.limit ?? input.top_k ?? 200;
    const result = graphCycles(visibleEdges, limit, signal);
    return { ...result, schema };
  }
  if (name === "deps" || name === "reverse_deps") {
    const selectedPath = input.file ?? input.path;
    const selected = selectedPath
      ? relative(root, path.resolve(root, selectedPath))
      : "";
    const values = visibleEdges.filter((edge) =>
      name === "deps" ? edge.from === selected : edge.to === selected,
    );
    return { schema, ...bounded(values, input) };
  }
  const target = input.target ?? "";
  const fullRange = input.detail === "full";
  const depth = input.direct ? 1 : (input.depth ?? 1);
  const callers = tracedCalls(
    files,
    root,
    target,
    "in",
    depth,
    fullRange,
    signal,
  );
  const callees = tracedCalls(
    files,
    root,
    target,
    "out",
    depth,
    fullRange,
    signal,
  );
  if (name === "callers") return { schema, ...bounded(callers, input) };
  if (name === "callees") return { schema, ...bounded(callees, input) };
  if (name === "trace")
    return {
      callees: bounded(callees, input),
      callers: bounded(callers, input),
      depth,
      schema,
      target,
    };
  const dependents = edges.filter((edge) => {
    throwIfAborted(signal);
    return edge.to.includes(target);
  });
  const tests = [...callers, ...dependents].filter((item) => {
    throwIfAborted(signal);
    return (
      "path" in item &&
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(
        item.path,
      )
    );
  });
  if (name === "impact")
    return {
      callees: bounded(callees, input),
      callers: bounded(callers, input),
      dependents: bounded(dependents, input),
      schema,
      target,
      tests: bounded(tests, input),
    };
  const definitions = files
    .flatMap((file) => {
      throwIfAborted(signal);
      return symbolMatches(file, target).flatMap(() => {
        throwIfAborted(signal);
        return symbolView(file, root, true);
      });
    })
    .filter(
      (item) =>
        item.name === target || item.qualifiedName.endsWith(`.${target}`),
    );
  const budget = input.budget ?? 32_000;
  const payload = {
    callees: [] as typeof callees,
    callers: [] as typeof callers,
    definitions: [] as typeof definitions,
    schema,
    target,
    truncated: false,
  };
  const candidates = [
    ...definitions.map((item) => ["definitions", item] as const),
    ...callers.map((item) => ["callers", item] as const),
    ...callees.map((item) => ["callees", item] as const),
  ];
  for (const [section, item] of candidates) {
    throwIfAborted(signal);
    const candidate = {
      ...payload,
      [section]: [...payload[section], item],
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > budget) {
      payload.truncated = true;
      break;
    }
    payload[section].push(item as never);
  }
  return payload;
}
