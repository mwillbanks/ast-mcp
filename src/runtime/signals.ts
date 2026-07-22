export const PROCESS_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export interface SignalHost {
  exit(code: number): unknown;
  off(signal: ProcessSignal, listener: () => void): unknown;
  on(signal: ProcessSignal, listener: () => void): unknown;
  stderr: { write(message: string): unknown };
}

export function installProcessSignalHandlers(
  shutdown: (signal: ProcessSignal) => Promise<void> | void,
  host: SignalHost = process,
) {
  let shuttingDown = false;
  const listeners = new Map<ProcessSignal, () => void>();

  for (const signal of PROCESS_SIGNALS) {
    const listener = () => {
      if (shuttingDown) {
        host.exit(1);
        return;
      }
      shuttingDown = true;
      void Promise.resolve()
        .then(() => shutdown(signal))
        .then(
          () => host.exit(0),
          (error) => {
            const detail =
              error instanceof Error ? error.message : String(error);
            host.stderr.write(
              `ast-mcp shutdown failed after ${signal}: ${detail}\n`,
            );
            host.exit(1);
          },
        );
    };
    listeners.set(signal, listener);
    host.on(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) host.off(signal, listener);
  };
}
