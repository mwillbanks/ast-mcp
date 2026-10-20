const POSIX_PROCESS_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const WINDOWS_PROCESS_SIGNALS = ["SIGINT", "SIGBREAK"] as const;

export type ProcessSignal =
  | (typeof POSIX_PROCESS_SIGNALS)[number]
  | (typeof WINDOWS_PROCESS_SIGNALS)[number];

export function processSignals(
  platform: NodeJS.Platform = process.platform,
): readonly ProcessSignal[] {
  return platform === "win32" ? WINDOWS_PROCESS_SIGNALS : POSIX_PROCESS_SIGNALS;
}

export const PROCESS_SIGNALS = processSignals();

export interface SignalHost {
  exit(code: number): unknown;
  off(signal: ProcessSignal, listener: () => void): unknown;
  on(signal: ProcessSignal, listener: () => void): unknown;
  stderr: { write(message: string): unknown };
}

export function installProcessSignalHandlers(
  shutdown: (signal: ProcessSignal) => Promise<void> | void,
  host: SignalHost = process,
  timeoutMs = 5000,
) {
  let shuttingDown = false;
  let finished = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Map<ProcessSignal, () => void>();
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    host.exit(code);
  };

  for (const signal of PROCESS_SIGNALS) {
    const listener = () => {
      if (shuttingDown) {
        finish(1);
        return;
      }
      shuttingDown = true;
      deadline = setTimeout(() => {
        host.stderr.write(`ast-mcp shutdown timed out after ${signal}\n`);
        finish(1);
      }, timeoutMs);
      void Promise.resolve()
        .then(() => shutdown(signal))
        .then(
          () => finish(0),
          (error) => {
            const detail =
              error instanceof Error ? error.message : String(error);
            host.stderr.write(
              `ast-mcp shutdown failed after ${signal}: ${detail}\n`,
            );
            finish(1);
          },
        );
    };
    listeners.set(signal, listener);
    host.on(signal, listener);
  }

  return () => {
    clearTimeout(deadline);
    for (const [signal, listener] of listeners) host.off(signal, listener);
  };
}

type FailureEvent = "uncaughtException" | "unhandledRejection";

export interface FailureHost {
  exitCode?: number | string | null;
  exit(code: number): unknown;
  off(event: FailureEvent, listener: (error: unknown) => void): unknown;
  on(event: FailureEvent, listener: (error: unknown) => void): unknown;
  stderr: { write(message: string): unknown };
}

export function installProcessFailureHandlers(
  shutdown: () => Promise<void> | void,
  host: FailureHost = process,
  timeoutMs = 5000,
) {
  let failing = false;
  let finished = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    host.exit(1);
  };
  const listeners = new Map<FailureEvent, (error: unknown) => void>();
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    const listener = (error: unknown) => {
      host.exitCode = 1;
      host.stderr.write(
        `ast-mcp fatal ${event}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (failing) {
        finish();
        return;
      }
      failing = true;
      deadline = setTimeout(() => {
        host.stderr.write("ast-mcp fatal shutdown timed out\n");
        finish();
      }, timeoutMs);
      const cleanupFailed = (shutdownError: unknown) => {
        host.stderr.write(
          `ast-mcp fatal cleanup failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}\n`,
        );
        finish();
      };
      try {
        void Promise.resolve(shutdown()).then(finish, cleanupFailed);
      } catch (shutdownError) {
        cleanupFailed(shutdownError);
      }
    };
    listeners.set(event, listener);
    host.on(event, listener);
  }
  return () => {
    clearTimeout(deadline);
    for (const [event, listener] of listeners) host.off(event, listener);
  };
}
