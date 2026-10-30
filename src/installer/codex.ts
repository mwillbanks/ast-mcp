import { isDeepStrictEqual } from "node:util";

import {
  launchFields,
  launchReceipt,
  parseLaunchReceipt,
  removeManagedEntry,
} from "./ownership";

type TomlDocument = Record<string, unknown>;

export { parseConfig as parseCodexConfig };

function parseConfig(content: string): TomlDocument {
  try {
    return Bun.TOML.parse(content) as TomlDocument;
  } catch (error) {
    throw new Error(
      "Cannot enable Codex MCP elicitation: invalid config.toml",
      {
        cause: error,
      },
    );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Split only at TOML statement boundaries, never inside strings or collections.
function statements(content: string) {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let multiline = false;
  let comment = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index]!;
    if (comment) {
      if (char !== "\n") continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && char === "\\") {
        index++;
        continue;
      }
      if (multiline && content.startsWith(quote.repeat(3), index)) {
        while (content[index + 1] === quote) index++;
        quote = "";
      } else if (!multiline && char === quote) {
        quote = "";
      }
      continue;
    } else if (char === "#") {
      comment = true;
      continue;
    } else if (char === '"' || char === "'") {
      quote = char;
      multiline = content.startsWith(char.repeat(3), index);
      if (multiline) index += 2;
      continue;
    } else if (char === "[" || char === "{") {
      depth++;
    } else if (char === "]" || char === "}") {
      depth--;
    }
    if (char === "\n" && depth === 0) {
      result.push(content.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < content.length) result.push(content.slice(start));
  return result;
}

function get(value: unknown, keys: string[]): unknown {
  for (const key of keys) {
    if (!record(value)) return undefined;
    value = value[key];
  }
  return value;
}

function headerPath(value: unknown): string[] | undefined {
  if (!record(value)) return undefined;
  if (Object.hasOwn(value, "__ast_mcp_probe")) return [];
  for (const [key, child] of Object.entries(value)) {
    const found = headerPath(Array.isArray(child) ? child[0] : child);
    if (found) return [key, ...found];
  }
  return undefined;
}

function inlineTable(value: Record<string, unknown>): string {
  return `{ ${Object.entries(value)
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)} = ${record(entry) ? inlineTable(entry) : String(entry)}`,
    )
    .join(", ")} }`;
}

function enabledPolicy(policy: unknown): unknown {
  if (policy === undefined || policy === "on-request" || policy === "untrusted")
    return policy;
  if (policy === "never")
    return {
      granular: {
        sandbox_approval: false,
        rules: false,
        mcp_elicitations: true,
        request_permissions: false,
        skill_approval: false,
      },
    };
  if (
    record(policy) &&
    Object.keys(policy).length === 1 &&
    record(policy.granular) &&
    Object.values(policy.granular).every((value) => typeof value === "boolean")
  )
    return { granular: { ...policy.granular, mcp_elicitations: true } };
  throw new Error(
    "Cannot preserve Codex approval_policy while enabling MCP elicitation; use on-request, never, or a granular policy",
  );
}

type PolicyTarget = { keys: string[]; policy: unknown; enabled: unknown };

function samePath(first: string[], second: string[]) {
  return (
    first.length === second.length &&
    first.every((key, index) => key === second[index])
  );
}

function assignmentValue(statement: string, replacement: string) {
  // The first equals sign outside a quoted key starts the assignment value.
  let quote = "";
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "=")
      return statement.slice(0, index + 1) + " " + replacement + "\n";
  }
  throw new Error("Cannot locate Codex approval assignment");
}

function codexLaunchReceipt(content: string) {
  const encoded = content.match(/^# ast-mcp:launch (.*)$/m)?.[1];
  if (!encoded) return undefined;
  try {
    return parseLaunchReceipt(JSON.parse(encoded));
  } catch {
    return undefined;
  }
}

/** Replace owned launch fields while retaining user tool and server settings. */
export function refreshCodexMcp(
  content: string,
  launch: Record<string, unknown>,
): string {
  const document = parseConfig(content);
  const servers = record(document.mcp_servers) ? document.mcp_servers : {};
  const existing = record(servers["ast-mcp"]) ? { ...servers["ast-mcp"] } : {};
  const receipt = launchReceipt(existing, launch, codexLaunchReceipt(content));
  for (const key of ["command", "args", "cwd", "url", "type"])
    delete existing[key];
  let section: string[] = [];
  const clean = statements(content)
    .filter((statement) => {
      if (
        /^# ast-mcp:(?:begin|end)\s*$/.test(statement.trim()) ||
        statement.startsWith("# ast-mcp:launch ")
      )
        return false;
      if (statement.trimStart().startsWith("[")) {
        section =
          headerPath(parseConfig(`${statement}\n__ast_mcp_probe = true\n`)) ??
          [];
        return !(section[0] === "mcp_servers" && section[1] === "ast-mcp");
      }
      if (section[0] === "mcp_servers" && section[1] === "ast-mcp")
        return false;
      const value = parseConfig(statement);
      if (Object.keys(value).length === 0) return true;
      const relative =
        headerPath(
          parseConfig(assignmentValue(statement, "{ __ast_mcp_probe = true }")),
        ) ?? [];
      const absolute = [...section, ...relative];
      if (absolute[0] === "mcp_servers" && absolute[1] === "ast-mcp")
        return false;
      if (
        record(value.mcp_servers) &&
        value.mcp_servers["ast-mcp"] !== undefined
      )
        throw new Error(
          "Expand inline Codex MCP server configuration before updating",
        );
      return true;
    })
    .join("")
    .trimEnd();
  const lines = [
    "[mcp_servers.ast-mcp]",
    ...Object.entries(launch).map(
      ([key, value]) => `${key} = ${JSON.stringify(value)}`,
    ),
  ];
  if (Object.keys(existing).length) {
    const retained = Bun.TOML.stringify({
      mcp_servers: { "ast-mcp": existing },
    });
    lines.push(retained.replace(/^\[mcp_servers\.ast-mcp\]\n/, "").trimEnd());
  }
  const block = `# ast-mcp:launch ${JSON.stringify(receipt)}\n# ast-mcp:begin\n${lines.join("\n")}\n# ast-mcp:end\n`;
  const result = `${clean ? `${clean}\n\n` : ""}${block}`;
  parseConfig(result);
  return result;
}

/** Enable elicitation while preserving unrelated TOML and approval categories. */
export function enableCodexElicitation(content: string, inheritedContent = "") {
  const document = parseConfig(content);
  const inherited = parseConfig(inheritedContent);
  const rootPolicy = document.approval_policy ?? inherited.approval_policy;
  const targets: PolicyTarget[] = [
    {
      keys: ["approval_policy"],
      policy: rootPolicy,
      enabled: enabledPolicy(rootPolicy),
    },
  ];
  const profiles = {
    ...(record(inherited.profiles) ? inherited.profiles : {}),
    ...(record(document.profiles) ? document.profiles : {}),
  };
  for (const name of Object.keys(profiles)) {
    const keys = ["profiles", name, "approval_policy"];
    const policy = get(document, keys) ?? get(inherited, keys);
    if (policy === undefined) continue;
    targets.push({ keys, policy, enabled: enabledPolicy(policy) });
  }
  const changed = targets.filter(
    ({ policy }) =>
      policy === "never" ||
      (record(policy) &&
        record(policy.granular) &&
        policy.granular.mcp_elicitations !== true),
  );
  if (changed.length === 0) return content;
  let section: string[] = [];
  const inserted = new Set<PolicyTarget>();
  let result = statements(content)
    .map((statement) => {
      if (statement.trimStart().startsWith("[")) {
        section =
          headerPath(parseConfig(`${statement}\n__ast_mcp_probe = true\n`)) ??
          [];
        const inheritedTarget = changed.find(
          (entry) =>
            entry.keys.length === 3 &&
            get(document, entry.keys) === undefined &&
            samePath(section, entry.keys.slice(0, -1)),
        );
        if (inheritedTarget) {
          inserted.add(inheritedTarget);
          return (
            statement.trimEnd() +
            "\napproval_policy = " +
            inlineTable(inheritedTarget.enabled as Record<string, unknown>) +
            "\n"
          );
        }
        const target = changed.find(
          (entry) =>
            samePath(section, [...entry.keys, "granular"]) &&
            get(entry.policy, ["granular", "mcp_elicitations"]) === undefined,
        );
        if (target) {
          inserted.add(target);
          return statement.trimEnd() + "\nmcp_elicitations = true\n";
        }
        return statement;
      }
      const assignment = parseConfig(statement);
      if (Object.keys(assignment).length === 0) return statement;
      const marker = assignmentValue(statement, "{ __ast_mcp_probe = true }");
      const relativePath = headerPath(parseConfig(marker));
      if (!relativePath)
        throw new Error("Cannot locate Codex configuration key");
      const absolute = [...section, ...relativePath];
      for (const target of changed) {
        if (samePath(absolute, target.keys))
          return assignmentValue(
            statement,
            inlineTable(target.enabled as Record<string, unknown>),
          );
        const granularKeys = [...target.keys, "granular"];
        if (samePath(absolute, granularKeys))
          return assignmentValue(
            statement,
            inlineTable(
              get(target.enabled, ["granular"]) as Record<string, unknown>,
            ),
          );
        const leafKeys = [...granularKeys, "mcp_elicitations"];
        if (samePath(absolute, leafKeys))
          return assignmentValue(statement, "true");
        if (
          absolute.length < target.keys.length &&
          absolute.every((key, index) => target.keys[index] === key) &&
          get(assignment, target.keys.slice(section.length)) !== undefined
        )
          throw new Error(
            "Expand inline Codex profiles before enabling MCP elicitation",
          );
        if (
          !inserted.has(target) &&
          get(target.policy, ["granular", "mcp_elicitations"]) === undefined &&
          granularKeys.every((key, index) => absolute[index] === key)
        ) {
          inserted.add(target);
          const key = leafKeys
            .slice(section.length)
            .map((part) => JSON.stringify(part))
            .join(".");
          return `${key} = true\n${statement}`;
        }
      }
      return statement;
    })
    .join("");
  if (
    document.approval_policy === undefined &&
    changed.some((entry) => samePath(entry.keys, ["approval_policy"]))
  ) {
    result = `approval_policy = ${inlineTable(targets[0]!.enabled as Record<string, unknown>)}\n${result}`;
  }
  for (const target of changed) {
    if (
      target.keys.length !== 3 ||
      get(document, target.keys) !== undefined ||
      inserted.has(target)
    )
      continue;
    const profilePath = target.keys.slice(0, -1);
    const candidate =
      result.trimEnd() +
      "\n\n[" +
      profilePath.map((part) => JSON.stringify(part)).join(".") +
      "]\napproval_policy = " +
      inlineTable(target.enabled as Record<string, unknown>) +
      "\n";
    if (get(document, profilePath) !== undefined) {
      try {
        Bun.TOML.parse(candidate);
      } catch (error) {
        throw new Error(
          "Expand inline Codex profiles before enabling MCP elicitation",
          { cause: error },
        );
      }
    }
    result = candidate;
  }
  const final = parseConfig(result);
  for (const target of changed) {
    const policy = get(final, target.keys);
    if (get(policy, ["granular", "mcp_elicitations"]) !== true)
      throw new Error(
        "Cannot safely enable Codex MCP elicitation in this TOML layout",
      );
  }
  const overlays = changed
    .map(
      (target) =>
        "# ast-mcp:approval-overlay " +
        JSON.stringify({
          keys: target.keys,
          enabled: target.enabled,
          ...(get(document, target.keys) !== undefined
            ? { previous: get(document, target.keys) }
            : {}),
        }) +
        "\n",
    )
    .join("");
  result = result.replace(
    /^# ast-mcp:approval-overlay (.*)\r?\n/gm,
    (line, encoded: string) => {
      try {
        const metadata = JSON.parse(encoded);
        return changed.some((target) =>
          isDeepStrictEqual(metadata?.keys, target.keys),
        )
          ? ""
          : line;
      } catch {
        return line;
      }
    },
  );
  return overlays + result;
}

/** Remove only generated overlays that the user has not subsequently changed. */
function removeApprovalOverlays(content: string): string {
  const document = parseConfig(content);
  const removable: Array<{ keys: string[]; previous?: unknown }> = [];
  const withoutMetadata = content.replace(
    /^# ast-mcp:approval-overlay (.*)\r?\n/gm,
    (_line, encoded: string) => {
      try {
        const overlay: unknown = JSON.parse(encoded);
        if (!record(overlay) || !Array.isArray(overlay.keys)) return "";
        const keys = overlay.keys;
        if (
          !(
            (keys.length === 1 && keys[0] === "approval_policy") ||
            (keys.length === 3 &&
              keys[0] === "profiles" &&
              typeof keys[1] === "string" &&
              keys[2] === "approval_policy")
          )
        )
          return "";
        if (isDeepStrictEqual(get(document, keys), overlay.enabled))
          removable.push({
            keys,
            ...(Object.hasOwn(overlay, "previous")
              ? { previous: overlay.previous }
              : {}),
          });
      } catch {
        // Unrecognized metadata never authorizes configuration removal.
      }
      return "";
    },
  );
  let section: string[] = [];
  const retained = statements(withoutMetadata)
    .filter((statement) => {
      if (statement.trimStart().startsWith("[")) {
        section =
          headerPath(parseConfig(statement + "\n__ast_mcp_probe = true\n")) ??
          [];
        return !removable.some(({ keys }) =>
          keys.every((key, index) => section[index] === key),
        );
      }
      if (Object.keys(parseConfig(statement)).length === 0) return true;
      const relative =
        headerPath(
          parseConfig(assignmentValue(statement, "{ __ast_mcp_probe = true }")),
        ) ?? [];
      const absolute = [...section, ...relative];
      return !removable.some(({ keys }) =>
        keys.every((key, index) => absolute[index] === key),
      );
    })
    .join("");
  const restored = removable.filter((entry) =>
    Object.hasOwn(entry, "previous"),
  );
  const chunks = statements(retained);
  const insertions = new Map<number, string[]>();
  for (const { keys, previous } of restored) {
    let position = -1;
    let prefix: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      if (!chunk.trimStart().startsWith("[")) continue;
      const candidate =
        headerPath(parseConfig(chunk + "\n__ast_mcp_probe = true\n")) ?? [];
      if (
        candidate.length < keys.length &&
        candidate.length > prefix.length &&
        candidate.every((key, part) => keys[part] === key)
      ) {
        position = index;
        prefix = candidate;
      }
    }
    const assignment =
      keys
        .slice(prefix.length)
        .map((key) => JSON.stringify(key))
        .join(".") +
      " = " +
      (record(previous) ? inlineTable(previous) : JSON.stringify(previous)) +
      "\n";
    insertions.set(position, [...(insertions.get(position) ?? []), assignment]);
  }
  const result =
    (insertions.get(-1) ?? []).join("") +
    chunks
      .map((chunk, index) => chunk + (insertions.get(index) ?? []).join(""))
      .join("");
  parseConfig(result);
  return result;
}

/** Uninstall launch fields without deleting retained user server configuration. */
export function removeCodexMcpConfiguration(content: string): string {
  const cleaned = removeApprovalOverlays(content);
  if (!/^# ast-mcp:begin\s*$/m.test(cleaned)) return cleaned;
  const document = parseConfig(cleaned);
  const servers = record(document.mcp_servers) ? document.mcp_servers : {};
  const existing = record(servers["ast-mcp"]) ? servers["ast-mcp"] : {};
  const legacyLaunchOnly =
    !/^# ast-mcp:launch /m.test(cleaned) &&
    Object.keys(existing).every((key) =>
      (launchFields as readonly string[]).includes(key),
    );
  const remaining = legacyLaunchOnly
    ? undefined
    : removeManagedEntry(existing, codexLaunchReceipt(cleaned));
  const refreshed = refreshCodexMcp(cleaned, {});
  return refreshed
    .replace(/^# ast-mcp:launch .*\r?\n/gm, "")
    .replace(/# ast-mcp:begin\n[\s\S]*?# ast-mcp:end\n?/g, () =>
      remaining
        ? Bun.TOML.stringify({ mcp_servers: { "ast-mcp": remaining } })
        : "",
    );
}
