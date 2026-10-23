type TomlDocument = Record<string, unknown>;

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
    if (get(document, profilePath) !== undefined)
      throw new Error(
        "Expand inline Codex profiles before enabling MCP elicitation",
      );
    result =
      result.trimEnd() +
      "\n\n[" +
      profilePath.map((part) => JSON.stringify(part)).join(".") +
      "]\napproval_policy = " +
      inlineTable(target.enabled as Record<string, unknown>) +
      "\n";
  }
  const final = parseConfig(result);
  for (const target of changed) {
    const policy = get(final, target.keys);
    if (get(policy, ["granular", "mcp_elicitations"]) !== true)
      throw new Error(
        "Cannot safely enable Codex MCP elicitation in this TOML layout",
      );
  }
  return result;
}
