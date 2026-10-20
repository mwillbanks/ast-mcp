import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SKILL_URI } from "../../src/skills";
import { spawnLiveProcess } from "./live-process";

export const skillsMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
type Message = {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
};
export async function exerciseSkillsRequests(
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Message>,
) {
  const discovery = await request("server/discover");
  expect(discovery.error, JSON.stringify(discovery)).toBeUndefined();
  expect(
    discovery.result.capabilities.extensions["io.modelcontextprotocol/skills"],
  ).toEqual({});
  const entry = await request("skills/get", { uri: SKILL_URI });
  expect(entry.error, JSON.stringify(entry)).toBeUndefined();
  for (const manifest of entry.result.skill.resources) {
    const read = await request("resources/read", { uri: manifest.uri });
    expect(read.error, manifest.uri + JSON.stringify(read)).toBeUndefined();
    const bytes =
      read.result.contents[0].text !== undefined
        ? Buffer.from(read.result.contents[0].text)
        : Buffer.from(read.result.contents[0].blob, "base64");
    expect(bytes.length).toBe(manifest.size);
    expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(
      manifest.digest,
    );
  }
  expect(
    (
      await request("resources/read", {
        uri: "skill://ast-mcp/%2e%2e/package.json",
      })
    ).error?.code,
  ).toBe(-32602);
  const tools = await request("tools/list");
  expect(
    tools.result.tools.some(
      (tool: { name: string }) => tool.name === "file_read",
    ),
  ).toBeTrue();
  expect((await request("skills/list")).result.skills[0].uri).toBe(SKILL_URI);
}

export async function exerciseSkillsStdio(executable: string, cwd: string) {
  const live = spawnLiveProcess(process.execPath, [executable, "mcp"], { cwd });
  let id = 0;
  try {
    await exerciseSkillsRequests(async (method, params = {}) => {
      const requestId = ++id;
      live.process.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: { ...params, _meta: skillsMeta },
        }) + "\n",
      );
      for (;;) {
        const message = JSON.parse(await live.readStdoutLine());
        if (message.id === requestId) return message;
      }
    });
    live.process.stdin.end();
    expect(await live.waitForExit()).toBe(0);
  } finally {
    await live.stop();
  }
}

export function modernHttpRequest(url: URL) {
  let id = 0;
  return async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: { ...params, _meta: skillsMeta },
      }),
    });
    const body = await response.text();
    const lines = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const result = lines.at(-1) ?? JSON.parse(body);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    return result as Message;
  };
}

export async function exerciseModernWorkspaceHttp(
  url: URL,
  fixture: string,
  storage: string,
) {
  const first = modernHttpRequest(url);
  const second = modernHttpRequest(url);
  async function call(
    request: ReturnType<typeof modernHttpRequest>,
    name: string,
    args: Record<string, unknown>,
  ) {
    const message = await request("tools/call", { name, arguments: args });
    expect(message.error, JSON.stringify(message)).toBeUndefined();
    return message.result;
  }
  const opened = await call(first, "workspace_open", {
    directory: fixture,
    storage: { kind: "explicit", path: storage },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBeTrue();
  const workspaceId = opened.structuredContent.data.workspace.workspaceId;
  const status = await call(second, "workspace_status", { workspaceId });
  expect(status.structuredContent.data.workspaces[0].workspaceId).toBe(
    workspaceId,
  );
  const anonymous = await call(second, "workspace_status", {});
  expect(anonymous.structuredContent.data.workspaces).toEqual([]);
  const mapped = await call(second, "map", {
    workspaceId,
    paths: ["entry.ts"],
  });
  expect(mapped.isError, JSON.stringify(mapped)).not.toBeTrue();
  expect(JSON.stringify(mapped)).toContain("publish");
  const indexed = await call(first, "index", { workspaceId, action: "build" });
  expect(indexed.isError, JSON.stringify(indexed)).not.toBeTrue();
  const retrieved = await call(second, "retrieve", {
    workspaceId,
    query: "publish",
    semantic: false,
  });
  expect(retrieved.isError, JSON.stringify(retrieved)).not.toBeTrue();
  expect(retrieved.structuredContent.data.results.length).toBeGreaterThan(0);
  const hashed = await call(second, "file_hash", {
    workspaceId,
    filePaths: ["modern.txt"],
  });
  const sha = hashed.structuredContent.data.files[0].sha256;
  const file = (expectedSha256: string) => ({
    "modern.txt": {
      expectedSha256,
      patchStrategy: "aider_block",
      aiderBlocks: [{ search: "original\n", replace: "updated\n" }],
    },
  });
  const stale = await call(first, "file_patch", {
    workspaceId,
    files: file("0".repeat(64)),
  });
  expect(stale.isError).toBeTrue();
  expect(JSON.stringify(stale)).toContain("hash");
  const recovered = await call(second, "file_hash", {
    workspaceId,
    filePaths: ["modern.txt"],
  });
  expect(recovered.structuredContent.data.files[0].sha256).toBe(sha);
  const patched = await call(first, "file_patch", {
    workspaceId,
    files: file(sha),
  });
  expect(patched.isError, JSON.stringify(patched)).not.toBeTrue();
  expect(await readFile(path.join(fixture, "modern.txt"), "utf8")).toBe(
    "updated\n",
  );
  const drifted = await call(second, "workspace_status", { workspaceId });
  expect(drifted.isError).toBeTrue();
  expect(JSON.stringify(drifted)).toContain("workspace");
  expect((await second("skills/list")).result.skills[0].uri).toBe(SKILL_URI);
}

export async function exerciseSkillsHttp(url: URL) {
  await exerciseSkillsRequests(modernHttpRequest(url));
  const malformed = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "skills/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9999,
      method: "skills/list",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    }),
  });
  expect(malformed.status).toBe(400);
  expect(((await malformed.json()) as Message).error?.code).toBe(-32602);
}
