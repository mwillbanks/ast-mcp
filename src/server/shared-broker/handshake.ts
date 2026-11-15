import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import path from "node:path";

const maxPacket = 32 * 1024;
const signaturePattern = /^[a-f0-9]{64}$/u;
const version = "ast-mcp-shared/1";

export interface BrokerLaunch {
  cwd: string;
}

export class BrokerHandshakeEof extends Error {
  constructor() {
    super("Shared MCP broker closed during handshake");
  }
}

function malformed(): Error {
  return new Error("Invalid shared MCP broker handshake");
}

function nonce(): string {
  return randomBytes(32).toString("hex");
}

function signature(
  secret: string,
  role: string,
  challenge: string,
  response: string,
  cwd?: string,
): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(JSON.stringify([version, role, challenge, response, cwd ?? null]))
    .digest("hex");
}

function matches(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    signaturePattern.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
  );
}

function checkedNonce(value: unknown): string {
  if (typeof value !== "string" || !signaturePattern.test(value))
    throw malformed();
  return value;
}

function checkedLaunch(input: unknown): BrokerLaunch {
  if (
    typeof input !== "string" ||
    !path.isAbsolute(input) ||
    input.includes("\0")
  )
    throw malformed();
  return { cwd: input };
}

/** Read only handshake bytes; any coalesced MCP bytes remain in the socket. */
async function readExactly(
  socket: Socket,
  size: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("readable", readable);
      socket.off("error", failed);
      socket.off("end", closed);
      socket.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new BrokerHandshakeEof());
    const aborted = () => failed(signal.reason);
    const readable = () => {
      const chunk = socket.read(size) as Buffer | null;
      if (!chunk) return;
      if (!Buffer.isBuffer(chunk) || chunk.length !== size) {
        failed(malformed());
        return;
      }
      cleanup();
      resolve(chunk);
    };
    socket.on("readable", readable);
    socket.once("error", failed);
    socket.once("end", closed);
    socket.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (socket.destroyed || socket.readableEnded) closed();
    else readable();
  });
}

async function packet(socket: Socket, signal: AbortSignal): Promise<unknown> {
  const header = await readExactly(socket, 4, signal);
  const size = header.readUInt32BE();
  if (!size || size > maxPacket) throw malformed();
  const bytes = await readExactly(socket, size, signal);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function send(socket: Socket, value: unknown): void {
  if (socket.destroyed || socket.writableEnded) throw malformed();
  const bytes = Buffer.from(JSON.stringify(value));
  if (!bytes.length || bytes.length > maxPacket) throw malformed();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(bytes.length);
  socket.write(Buffer.concat([header, bytes]));
}

export async function authenticateBrokerClient(
  socket: Socket,
  secret: string,
  signal: AbortSignal,
): Promise<BrokerLaunch> {
  const challenge = nonce();
  send(socket, challenge);
  const response = checkedNonce(await packet(socket, signal));
  send(socket, signature(secret, "server", challenge, response));
  const request = await packet(socket, signal);
  if (!Array.isArray(request) || request.length !== 2) throw malformed();
  const launch = checkedLaunch(request[0]);
  if (
    !matches(
      request[1],
      signature(secret, "client", challenge, response, launch.cwd),
    )
  )
    throw malformed();
  return launch;
}

export function announceBrokerReady(socket: Socket): void {
  send(socket, "ready");
}

export async function connectBrokerSession(
  socket: Socket,
  launch: BrokerLaunch,
  secret: string,
  signal: AbortSignal,
): Promise<void> {
  checkedLaunch(launch.cwd);
  const challenge = checkedNonce(await packet(socket, signal));
  const response = nonce();
  send(socket, response);
  const proof = await packet(socket, signal);
  if (!matches(proof, signature(secret, "server", challenge, response)))
    throw malformed();
  send(socket, [
    launch.cwd,
    signature(secret, "client", challenge, response, launch.cwd),
  ]);
  if ((await packet(socket, signal)) !== "ready") throw malformed();
}
