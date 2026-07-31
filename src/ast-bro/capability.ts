import path from "node:path";
import { captureProcess, successfulProcessOutput } from "../helpers/process";
import { AST_BRO_BINARY } from "./client";

type AstBroMapPayload = {
  files?: Array<{ error_count?: number; path?: unknown }>;
};

export async function astErrorCount(
  filePath: string,
  language?: string,
): Promise<number | undefined> {
  const command = [AST_BRO_BINARY, "map", "--json", filePath];
  void language;
  const process = Bun.spawn(command, {
    cwd: path.dirname(filePath),
    env: { ...Bun.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = successfulProcessOutput(
    "ast-bro map",
    await captureProcess(process),
  );
  const payload = JSON.parse(output) as AstBroMapPayload;
  const file = (payload.files ?? []).find((entry) => entry.path === filePath);
  return file ? (file.error_count ?? 0) : undefined;
}

export async function astCapable(
  filePath: string,
  language?: string,
): Promise<boolean> {
  return (await astErrorCount(filePath, language)) === 0;
}
