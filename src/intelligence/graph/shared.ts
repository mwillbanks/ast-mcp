import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  RevisionMembershipSchema,
  revisionMembershipIdentity,
} from "../contracts/graph.ts";
import type { GraphScope } from "./types.ts";

export function exactObject(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function compareSourceRanges(
  left: { end: { index: number }; start: { index: number } },
  right: { end: { index: number }; start: { index: number } },
  kinds?: { left: string; right: string },
): number {
  return (
    left.start.index - right.start.index ||
    left.end.index - right.end.index ||
    (kinds ? kinds.left.localeCompare(kinds.right) : 0)
  );
}

export function createAuthenticatedCursorCodec<T>(options: {
  authenticationError: string;
  domain: string;
  envelopeError: string;
}): {
  decode(cursor: string, binding: string): unknown;
  encode(value: T, binding: string): string;
} {
  const key = randomBytes(32);
  const mac = (payload: string, binding: string): Buffer =>
    createHmac("sha256", key)
      .update(options.domain)
      .update("\0")
      .update(binding)
      .update("\0")
      .update(payload)
      .digest();
  return {
    decode(cursor, binding) {
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new Error(options.envelopeError);
      const [payload, signature] = parts;
      if (!payload || !signature || !/^[a-f0-9]{64}$/u.test(signature))
        throw new Error(options.envelopeError);
      const expected = mac(payload, binding);
      const received = Buffer.from(signature, "hex");
      if (
        received.byteLength !== expected.byteLength ||
        !timingSafeEqual(received, expected)
      )
        throw new Error(options.authenticationError);
      return JSON.parse(Buffer.from(payload, "base64url").toString());
    },
    encode(value, binding) {
      const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${payload}.${mac(payload, binding).toString("hex")}`;
    },
  };
}

export function createGraphMemberships(
  scope: GraphScope,
  entities: {
    edges: Iterable<string>;
    evidence: Iterable<string>;
    nodes: Iterable<string>;
    occurrences: Iterable<string>;
  },
) {
  const entityKinds = [
    ...Array.from(entities.nodes, (entityId) => ({
      entityId,
      entityKind: "node" as const,
    })),
    ...Array.from(entities.occurrences, (entityId) => ({
      entityId,
      entityKind: "occurrence" as const,
    })),
    ...Array.from(entities.edges, (entityId) => ({
      entityId,
      entityKind: "edge" as const,
    })),
    ...Array.from(entities.evidence, (entityId) => ({
      entityId,
      entityKind: "evidence" as const,
    })),
  ];
  return entityKinds.map((item) =>
    RevisionMembershipSchema.parse({
      ...item,
      generationId: scope.generationId,
      membershipId: revisionMembershipIdentity({
        ...item,
        generationId: scope.generationId,
        revisionId: scope.revisionId,
      }),
      revisionId: scope.revisionId,
    }),
  );
}
