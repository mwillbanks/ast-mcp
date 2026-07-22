// fallow-ignore-file unused-class-member -- start and send are required Transport interface methods
// fallow-ignore-file unused-class-member -- start and send are required Transport interface methods
// fallow-ignore-file stale-suppression -- Fallow cannot model external MCP Transport dispatch

import type { Readable, Writable } from "node:stream";
import {
  deserializeMessage,
  type JSONRPCMessage,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/server";

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export class BatchingStdioServerTransport implements Transport {
  private buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
  ) {}

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly onData = (chunk: Buffer | string) => {
    try {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.buffer.length + next.length > MAX_BUFFER_SIZE) {
        this.buffer = Buffer.alloc(0);
        throw new Error(
          `Stdio input exceeded maximum size of ${MAX_BUFFER_SIZE} bytes`,
        );
      }
      this.buffer = Buffer.concat([this.buffer, next]);
      this.processReadBuffer();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  };

  private readonly onError = (error: Error) => {
    this.onerror?.(error);
  };

  async start() {
    if (this.started) throw new Error("Stdio transport already started");
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onError);
    this.stdout.on("error", this.onError);
  }

  private reportInvalidRequest(error: Error) {
    this.onerror?.(error);
    void this.send({
      error: { code: -32600, message: "Invalid Request" },
      id: null,
      jsonrpc: "2.0",
    } as unknown as JSONRPCMessage).catch((sendError) => {
      this.onerror?.(
        sendError instanceof Error ? sendError : new Error(String(sendError)),
      );
    });
  }

  private processReadBuffer() {
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) return;

      const line = this.buffer
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);

      try {
        const parsed: unknown = JSON.parse(line);
        if (Array.isArray(parsed) && parsed.length === 0) {
          this.reportInvalidRequest(
            new Error("JSON-RPC batches must not be empty"),
          );
          continue;
        }
        const messages = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(
          (message) => {
            try {
              return [deserializeMessage(JSON.stringify(message))];
            } catch (error) {
              this.reportInvalidRequest(
                error instanceof Error ? error : new Error(String(error)),
              );
              return [];
            }
          },
        );
        for (const message of messages) this.onmessage?.(message);
      } catch (error) {
        this.reportInvalidRequest(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onError);
    this.stdout.off("error", this.onError);
    if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: JSONRPCMessage) {
    if (this.closed)
      return Promise.reject(new Error("Stdio transport is closed"));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        this.stdout.off("error", onError);
        this.stdout.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        this.stdout.off("error", onError);
        this.stdout.off("drain", onDrain);
        resolve();
      };

      this.stdout.once("error", onError);
      if (this.stdout.write(serializeMessage(message))) {
        if (settled) return;
        settled = true;
        this.stdout.off("error", onError);
        resolve();
      } else {
        this.stdout.once("drain", onDrain);
      }
    });
  }
}
