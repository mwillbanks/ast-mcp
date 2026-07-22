import { readFile } from "node:fs/promises";
import path from "node:path";

type EvalCase = {
  id: number;
  surface: string;
  category: "positive" | "variant" | "negative";
  variant: string;
  prompt: string;
  expected_output: string;
  required_tools: string[];
  forbidden_tools: string[];
  assertions: string[];
  files: string[];
};

type EvalSuite = {
  skill_name: string;
  mcp_tools: string[];
  special_surfaces?: string[];
  evals: EvalCase[];
};

const suitePath = path.join(import.meta.dir, "evals.json");
const suite = await (async () => {
  const [primaryJson, fileHashJson, batchJson] = await Promise.all([
    readFile(suitePath, "utf8"),
    readFile(path.join(import.meta.dir, "file-hash.evals.json"), "utf8"),
    readFile(path.join(import.meta.dir, "batch.evals.json"), "utf8"),
  ]);
  const primary = JSON.parse(primaryJson) as EvalSuite;
  const fileHashEvals = JSON.parse(fileHashJson) as EvalCase[];
  const batchEvals = JSON.parse(batchJson) as EvalCase[];
  return {
    ...primary,
    evals: [...primary.evals, ...fileHashEvals, ...batchEvals],
  };
})();
const errors: string[] = [];
const known = new Set([...suite.mcp_tools, ...(suite.special_surfaces ?? [])]);

if (suite.skill_name !== "ast-mcp") errors.push("skill_name must be ast-mcp");

if (new Set(suite.mcp_tools).size !== suite.mcp_tools.length)
  errors.push("mcp_tools contains duplicate names");

if (suite.evals.length < known.size * 3)
  errors.push("suite must contain at least three cases per surface");

const ids = new Set<number>();
for (const evaluation of suite.evals) {
  if (ids.has(evaluation.id))
    errors.push(`duplicate eval id: ${evaluation.id}`);
  ids.add(evaluation.id);

  if (!known.has(evaluation.surface))
    errors.push(`unknown surface: ${evaluation.surface}`);

  for (const tool of [
    ...evaluation.required_tools,
    ...evaluation.forbidden_tools,
  ])
    if (!known.has(tool))
      errors.push(`eval ${evaluation.id} references unknown tool: ${tool}`);

  if (!evaluation.prompt || !evaluation.expected_output)
    errors.push(`eval ${evaluation.id} must define prompt and expected_output`);

  if (evaluation.assertions.length < 3)
    errors.push(`eval ${evaluation.id} needs at least three assertions`);
}

for (const surface of known) {
  const cases = suite.evals.filter(
    (evaluation) => evaluation.surface === surface,
  );
  if (cases.length < 3) errors.push(`${surface} has fewer than three cases`);
  if (
    cases.filter((evaluation) => evaluation.category === "positive").length < 1
  )
    errors.push(`${surface} has no positive case`);
  if (
    cases.filter((evaluation) => evaluation.category === "variant").length < 1
  )
    errors.push(`${surface} has no variant case`);
  if (
    cases.filter((evaluation) => evaluation.category === "negative").length < 1
  )
    errors.push(`${surface} has no negative case`);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(
  `Validated ${suite.evals.length} eval cases across ${suite.mcp_tools.length} MCP surfaces.`,
);
