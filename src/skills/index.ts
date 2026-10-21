import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  ProtocolError,
  INVALID_PARAMS,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const SKILL_URI = "skill://ast-mcp/SKILL.md";
export const SKILL_EXTENSION = "io.modelcontextprotocol/skills";
export const bundledSkillRoot = path.resolve(
  import.meta.dir,
  import.meta.path.endsWith(".ts")
    ? "../../templates/skills/ast-mcp"
    : "../templates/skills/ast-mcp",
);
const cache = {
  resultType: "complete" as const,
  ttlMs: 300_000,
  cacheScope: "public" as const,
};
const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export interface SkillFile {
  relative: string;
  uri: string;
  bytes: Buffer;
  mimeType: string;
}

function mimeType(name: string) {
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".json")) return "application/json";
  if (/\.ya?ml$/.test(name)) return "application/yaml";
  return "text/plain";
}

function frontmatter(bytes: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Bundled skill requires YAML frontmatter");
  const value: unknown = Bun.YAML.parse(match[1]);
  const parsed = z.record(z.string(), z.json()).parse(value);
  if (
    parsed.name !== "ast-mcp" ||
    typeof parsed.description !== "string" ||
    !parsed.description.trim()
  )
    throw new Error("Bundled skill requires its matching name and description");
  return parsed;
}

export async function createSkillCatalog(root = bundledSkillRoot) {
  const files: SkillFile[] = [];
  let size = 0;
  async function visit(relative: string) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink())
      throw new Error("Bundled skills cannot contain symbolic links");
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(absolute))
        .filter((entry) => !entry.startsWith("."))
        .sort())
        await visit(path.join(relative, entry));
    } else if (metadata.isFile()) {
      const bytes = await readFile(absolute);
      size += bytes.length;
      if (files.length >= 512 || size > 16 * 1024 * 1024)
        throw new Error("Bundled skill exceeds resource limits");
      const portable = relative.split(path.sep).join("/");
      files.push({
        relative: portable,
        uri: `skill://ast-mcp/${portable.split("/").map(encodeURIComponent).join("/")}`,
        bytes,
        mimeType: mimeType(portable),
      });
    } else throw new Error("Bundled skills must contain regular files");
  }
  await visit("");
  const resources = new Map(files.map((file) => [file.uri, file]));
  const instructions = resources.get(SKILL_URI);
  if (!instructions) throw new Error("Bundled skill is missing SKILL.md");
  const skill = {
    uri: SKILL_URI,
    frontmatter: frontmatter(instructions.bytes),
    resources: files.map(({ uri, bytes }) => ({
      uri,
      digest: digest(bytes),
      size: bytes.length,
    })),
  };
  const identity = digest(Buffer.from(JSON.stringify(skill)));
  function offset(cursor: string | undefined, namespace: string) {
    if (cursor === undefined) return 0;
    const match = new RegExp(
      `^${namespace}:${identity.slice(7)}:([1-9][0-9]*)$`,
    ).exec(cursor);
    const value = match ? Number(match[1]) : NaN;
    if (
      !Number.isSafeInteger(value) ||
      value >= files.length ||
      value % 10 !== 0
    )
      throw new ProtocolError(
        INVALID_PARAMS,
        "Unknown or stale resource cursor",
      );
    return value;
  }
  return {
    files,
    list(cursor?: string) {
      if (cursor !== undefined)
        throw new ProtocolError(INVALID_PARAMS, "Unknown skill cursor");
      return { ...cache, skills: [structuredClone(skill)] };
    },
    get(uri: string) {
      if (uri !== SKILL_URI)
        throw new ProtocolError(INVALID_PARAMS, "Unknown skill URI");
      return { ...cache, skill: structuredClone(skill) };
    },
    listResources(cursor?: string) {
      const start = offset(cursor, "resources");
      const page = files
        .slice(start, start + 10)
        .map(({ uri, relative, mimeType }) => ({
          uri,
          name: relative,
          mimeType,
        }));
      const nextCursor =
        start + 10 < files.length
          ? `resources:${identity.slice(7)}:${start + 10}`
          : undefined;
      return {
        ...cache,
        resources: page,
        ...(nextCursor ? { nextCursor } : {}),
      };
    },
    read(uri: string) {
      const file = resources.get(uri);
      if (!file)
        throw new ProtocolError(INVALID_PARAMS, "Unknown skill resource URI");
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(file.bytes);
      return { ...cache, contents: [{ uri, mimeType: file.mimeType, text }] };
    },
  };
}

let catalog: ReturnType<typeof createSkillCatalog> | undefined;
export function bundledSkills() {
  return (catalog ??= createSkillCatalog());
}

export function registerSkills(server: McpServer) {
  server.server.registerCapabilities({
    resources: {},
    extensions: { [SKILL_EXTENSION]: {} },
  });
  const pagination = z.object({ cursor: z.string().optional() });
  server.server.setRequestHandler(
    "skills/list",
    { params: pagination },
    async (params) => (await bundledSkills()).list(params.cursor),
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }) },
    async (params) => (await bundledSkills()).get(params.uri),
  );
  server.server.setRequestHandler("resources/list", async (request) =>
    (await bundledSkills()).listResources(request.params?.cursor),
  );
  server.server.setRequestHandler("resources/templates/list", async () => ({
    ...cache,
    resourceTemplates: [],
  }));
  server.server.setRequestHandler("resources/read", async (request) =>
    (await bundledSkills()).read(request.params.uri),
  );
}
