import { appendFile } from "node:fs/promises";

import { candidateCommand, type CandidateIo } from "./candidate-policy.ts";

const io: CandidateIo = {
  executable: process.execPath,
  env: process.env,
  file: Bun.file,
  append: appendFile,
  upload: async (url, filename) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (process.env.GH_TOKEN ?? ""),
        "Content-Type": "application/octet-stream",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: Bun.file(filename),
      signal: AbortSignal.timeout(120_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  },
  write: (content) => {
    process.stdout.write(content);
  },
  run: async (args, options = {}) => {
    const child = Bun.spawn(args, {
      cwd: options.cwd,
      stdin:
        options.input === undefined ? "ignore" : Buffer.from(options.input),
      stdout: options.outputFile ? Bun.file(options.outputFile) : "pipe",
      stderr: options.inheritStderr ? "inherit" : "pipe",
      timeout: options.timeoutMs ?? 120_000,
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      child.stdout instanceof ReadableStream
        ? new Response(child.stdout).text()
        : "",
      child.stderr instanceof ReadableStream
        ? new Response(child.stderr).text()
        : "",
    ]);
    return { code, output, error };
  },
};

await candidateCommand(Bun.argv.slice(2), io);
