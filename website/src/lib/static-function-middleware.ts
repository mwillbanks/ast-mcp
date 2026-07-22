import {
  createMiddleware,
  type FunctionClientResultWithContext,
  getDefaultSerovalPlugins,
} from "@tanstack/react-start";
import { fromJSON } from "seroval";

type StaticCachedResult = {
  context?: Record<string, unknown>;
  result: unknown;
};

const staticClientCache = new Map<string, Promise<StaticCachedResult>>();

async function sha1Hash(message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest("SHA-1", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function filenameSafeData(data: unknown): string {
  const sortObjectKeys = (_key: string, value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = record[key];
        return sorted;
      }, {});
  };

  return JSON.stringify(data ?? "", sortObjectKeys)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_");
}

function normalizeBaseUrl(baseUrl: string): string {
  const leadingSlash = baseUrl.startsWith("/") ? baseUrl : `/${baseUrl}`;
  return leadingSlash.endsWith("/") ? leadingSlash : `${leadingSlash}/`;
}

export async function createStaticCacheUrl(
  functionId: string,
  data: unknown,
  baseUrl = import.meta.env.BASE_URL,
): Promise<string> {
  const hash = await sha1Hash(`${functionId}__${filenameSafeData(data)}`);
  return `${normalizeBaseUrl(baseUrl)}__tsr/staticServerFnCache/${hash}.json`;
}

async function fetchStaticResult(
  functionId: string,
  data: unknown,
): Promise<StaticCachedResult> {
  const url = await createStaticCacheUrl(functionId, data);
  const cached = staticClientCache.get(url);
  if (cached) return cached;

  const request = fetch(url, { method: "GET" }).then(async (response) => {
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      throw new Error(
        `Unable to load static server-function cache ${url}: ${response.status} ${response.statusText}`,
      );
    }

    const serialized = await response.json();
    return fromJSON(serialized, {
      plugins: getDefaultSerovalPlugins(),
    }) as StaticCachedResult;
  });

  staticClientCache.set(url, request);
  return request;
}

export const basePathStaticFunctionMiddleware = createMiddleware({
  type: "function",
}).client(async (context) => {
  if (
    process.env.NODE_ENV === "production" &&
    typeof document !== "undefined"
  ) {
    const cached = await fetchStaticResult(
      context.serverFnMeta.id,
      context.data,
    );

    return {
      context: { ...(context.context ?? {}), ...cached.context },
      result: cached.result,
    } as unknown as FunctionClientResultWithContext<
      unknown,
      undefined,
      undefined
    >;
  }

  return context.next();
});
