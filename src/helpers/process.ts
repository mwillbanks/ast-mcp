type CapturedProcess = {
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array> | number | null | undefined;
  stdout: ReadableStream<Uint8Array> | number | null | undefined;
};

export async function captureProcess(
  processHandle: CapturedProcess,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    processHandle.stdout instanceof ReadableStream
      ? new Response(processHandle.stdout).text()
      : Promise.resolve(""),
    processHandle.stderr instanceof ReadableStream
      ? new Response(processHandle.stderr).text()
      : Promise.resolve(""),
  ]);
  return { exitCode, stderr, stdout };
}

export function successfulProcessOutput(
  command: string,
  result: { exitCode: number; stderr: string; stdout: string },
): string {
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || `${command} exited with code ${result.exitCode}`,
    );
  return result.stdout.trimEnd();
}
