import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

export type NativeWorkerKind = "parser" | "code-intelligence" | "patch";

export function isEmbeddedBunExecutable(): boolean {
  return (
    Bun.main.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(Bun.main)
  );
}

/** ast-grep's N-API registry is process-wide. An isolate cannot replace it. */
export function createNativeProcess(workerUrl: URL, kind: NativeWorkerKind) {
  const events = new EventEmitter<{
    error: [Error];
    exit: [number];
    message: [unknown];
  }>();
  const env =
    process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
      : {};

  const argv = isEmbeddedBunExecutable()
    ? [process.execPath, `--ast-mcp-internal-native-worker=${kind}`]
    : [process.execPath, "--no-env-file", fileURLToPath(workerUrl)];
  const child = Bun.spawn(argv, {
    env,
    ipc: (message) => events.emit("message", message),
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  void child.exited.then(
    (code) => events.emit("exit", code),
    (error: Error) => events.emit("error", error),
  );
  return Object.assign(events, {
    postMessage(message: unknown) {
      child.send(message);
    },
    ref() {
      child.ref();
    },
    async terminate() {
      child.kill("SIGKILL");
      return await child.exited;
    },
    unref() {
      child.unref();
    },
  });
}

export function createNativeProcessTransport(
  workerUrl: URL,
  kind: NativeWorkerKind,
): Worker {
  const child = createNativeProcess(workerUrl, kind);
  const events = new EventTarget();
  let closing = false;
  const transport = Object.assign(events, {
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: child.postMessage,
    ref: child.ref,
    terminate() {
      closing = true;
      return child.terminate();
    },
    unref: child.unref,
  });
  child.on("message", (data) => {
    const event = new MessageEvent("message", { data });
    transport.onmessage?.(event);
    events.dispatchEvent(event);
  });
  const failed = (message: string) => {
    if (closing) return;
    const event = new ErrorEvent("error", { message });
    transport.onerror?.(event);
    events.dispatchEvent(event);
  };
  child.on("error", (error) => failed(error.message));
  child.on("exit", (code) =>
    failed(`Native parser process exited with code ${code}`),
  );
  return transport as unknown as Worker;
}
