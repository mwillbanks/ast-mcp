import path from "node:path";
import { captureProcess, successfulProcessOutput } from "../helpers/process";
import { AST_BRO_BINARY } from "./client";

type AstBroMapPayload = {
  files?: Array<{ error_count?: number; path?: unknown }>;
};

export async function astCapable(
  filePath: string,
  language?: string,
): Promise<boolean> {
  if (!language) return false;
  const processHandle = Bun.spawn([AST_BRO_BINARY, "map", "--json", filePath], {
    cwd: path.dirname(filePath),
    stderr: "pipe",
    stdout: "pipe",
  });
  const result = await captureProcess(processHandle);
  const stdout = successfulProcessOutput("ast-bro map", result);
  const payload = JSON.parse(stdout) as AstBroMapPayload;
  const file = (payload.files ?? []).find(
    (candidate) => candidate.path === filePath,
  );
  return file?.error_count === 0;
}
