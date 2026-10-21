// fallow-ignore-file unused-class-member -- start and send are required Transport interface methods
// fallow-ignore-file stale-suppression -- Fallow cannot model external MCP Transport dispatch

import type { Readable, Writable } from "node:stream";

import {
  deserializeMessage,
  type JSONRPCMessage,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/server";

const MAX_FRAME_SIZE = 10 * 1024 * 1024;

export class BatchingStdioServerTransport implements Transport {
  private frame = Buffer.alloc(0);
  private frameSize = 0;
  private discarding = false;
  private started = false;
  private closed = false;
  private readonly pendingWrites = new Set<(error: Error) => void>();

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
  ) {}

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private reportError(error: unknown) {
    this.onerror?.(error instanceof Error ? error : new Error(String(error)));
  }

  private readonly onData = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const length = end - offset;
      if (!this.discarding) {
        if (this.frameSize + length > MAX_FRAME_SIZE) {
          this.frame = Buffer.alloc(0);
          this.frameSize = 0;
          this.discarding = true;
          this.reportProtocolError(
            new Error(
              `Stdio input exceeded maximum frame size of ${MAX_FRAME_SIZE} bytes`,
            ),
            -32700,
            "Parse error",
          );
        } else if (length > 0) {
          const required = this.frameSize + length;
          if (required > this.frame.length) {
            const capacity = Math.min(
              MAX_FRAME_SIZE,
              Math.max(required, 1024, this.frame.length * 2),
            );
            const grown = Buffer.allocUnsafe(capacity);
            this.frame.copy(grown, 0, 0, this.frameSize);
            this.frame = grown;
          }
          bytes.copy(this.frame, this.frameSize, offset, end);
          this.frameSize = required;
        }
      }
      if (newline === -1) break;
      if (!this.discarding) {
        const line = this.frame
          .subarray(0, this.frameSize)
          .toString("utf8")
          .replace(/\r$/, "");
        this.frameSize = 0;
        if (line.length > 0) this.processLine(line);
      }
      this.discarding = false;
      offset = newline + 1;
    }
  };

  private readonly onError = (error: Error) => {
    this.reportError(error);
    void this.close();
  };

  private readonly onEnd = () => {
    if (this.frameSize > 0 && !this.discarding)
      this.reportError(new Error("Stdio input ended during a JSON-RPC frame"));
    void this.close();
  };

  async start() {
    if (this.started) throw new Error("Stdio transport already started");
    if (this.closed) throw new Error("Stdio transport is closed");
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onError);
    this.stdin.on("end", this.onEnd);
    this.stdin.on("close", this.onEnd);
    this.stdout.on("error", this.onError);
    this.stdout.on("close", this.onEnd);
    if (this.stdin.readableEnded || this.stdin.destroyed) this.onEnd();
  }

  private reportProtocolError(
    error: Error,
    code: number,
    message: string,
    id: string | number | null = null,
  ) {
    this.reportError(error);
    void this.send({
      error: { code, message },
      id,
      jsonrpc: "2.0",
    } as unknown as JSONRPCMessage).catch((sendError) =>
      this.reportError(sendError),
    );
  }

  private deserializeItem(item: unknown) {
    try {
      return deserializeMessage(JSON.stringify(item));
    } catch (error) {
      this.reportProtocolError(
        error instanceof Error ? error : new Error(String(error)),
        -32600,
        "Invalid Request",
      );
    }
  }

  private processLine(line: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.reportProtocolError(
        error instanceof Error ? error : new Error(String(error)),
        -32700,
        "Parse error",
      );
      return;
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      this.reportProtocolError(
        new Error("JSON-RPC batches must not be empty"),
        -32600,
        "Invalid Request",
      );
      return;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (this.closed) return;
      const message = this.deserializeItem(item);
      if (!message) continue;
      try {
        this.onmessage?.(message);
      } catch (error) {
        this.reportError(error);
        if ("method" in message && "id" in message)
          this.reportProtocolError(
            new Error("MCP request handler failed"),
            -32603,
            "Internal error",
            typeof message.id === "string" || typeof message.id === "number"
              ? message.id
              : null,
          );
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onError);
    this.stdin.off("end", this.onEnd);
    this.stdin.off("close", this.onEnd);
    this.stdout.off("error", this.onError);
    this.stdout.off("close", this.onEnd);
    if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    this.frame = Buffer.alloc(0);
    this.frameSize = 0;
    for (const reject of this.pendingWrites)
      reject(new Error("Stdio transport is closed"));
    this.pendingWrites.clear();
    this.onclose?.();
  }

  send(message: JSONRPCMessage) {
    if (this.closed)
      return Promise.reject(new Error("Stdio transport is closed"));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.stdout.off("error", onError);
        this.stdout.off("close", onClose);
        this.stdout.off("drain", onDrain);
        this.pendingWrites.delete(onError);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onClose = () => onError(new Error("Stdio output is closed"));

      this.pendingWrites.add(onError);
      this.stdout.once("error", onError);
      this.stdout.once("close", onClose);
      try {
        if (this.stdout.write(serializeMessage(message))) onDrain();
        else if (!settled) this.stdout.once("drain", onDrain);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        onError(failure);
        this.onError(failure);
      }
    });
  }
}
