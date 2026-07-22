import { scoreTranscript } from "./score";

const args = process.argv.slice(2);
const strict = args[0] === "--strict";
const sessionPaths = strict ? args.slice(1) : args;

if (sessionPaths.length === 0) {
  console.error(
    "Usage: bun run templates/skills/ast-mcp/evals/measure.ts <session.jsonl> [...session.jsonl]",
  );
  process.exit(2);
}

for (const sessionPath of sessionPaths) {
  const result = await scoreTranscript(sessionPath, strict);
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
