import { scoreTranscript } from "./score";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const sessionPaths = args.filter((argument) => !argument.startsWith("--"));
const knownOptions = new Set([
  "--allow-any-path",
  "--no-temp-directory",
  "--strict",
]);
const requestedOptions = new Set(
  args.filter((argument) => argument.startsWith("--")),
);
const unknownOption = [...requestedOptions].find(
  (option) => !knownOptions.has(option),
);
if (unknownOption) {
  console.error(`Unknown option: ${unknownOption}`);
  process.exit(2);
}
const fileOperationPolicy = {
  allowAnyPath: requestedOptions.has("--allow-any-path"),
  allowTempDirectory: !requestedOptions.has("--no-temp-directory"),
};

if (sessionPaths.length === 0) {
  console.error(
    "Usage: bun run templates/skills/ast-mcp/evals/measure.ts [--strict] [--allow-any-path] [--no-temp-directory] <session.jsonl> [...session.jsonl]",
  );
  process.exit(2);
}

for (const sessionPath of sessionPaths) {
  const result = await scoreTranscript(
    sessionPath,
    strict,
    fileOperationPolicy,
  );
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
