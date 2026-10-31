import { expect, spyOn, test } from "bun:test";

import { spawnHttpMcpProcess, spawnLiveProcess } from "../support/live-process";

const fastFailure =
  'import { writeSync } from "node:fs";writeSync(2,"startup failed\\n");process.exit(7)';
const stubbornDescendant =
  'process.on("SIGTERM",()=>{});console.error("descendant ready");await Bun.sleep(30_000)';

test("live process captures both streams and supports repeated teardown", async () => {
  const live = spawnLiveProcess(process.execPath, [
    "-e",
    'console.log("ready");console.error("fixture warning");await Bun.sleep(8_000)',
  ]);
  try {
    expect(await live.readStdoutLine()).toBe("ready");
    await live.waitForStderr(/fixture warning/);
    expect(live.diagnostics()).toContain("stdout:\nready");
    expect(live.diagnostics()).toContain("stderr:\nfixture warning");
  } finally {
    await live.stop();
    await live.stop();
  }
});

test("live process reports bounded waiting and premature exit diagnostics", async () => {
  const silent = spawnLiveProcess(process.execPath, [
    "-e",
    "await Bun.sleep(8_000)",
  ]);
  try {
    expect(silent.diagnostics()).toBe("no process output");
    await expect(silent.readStdoutLine(25)).rejects.toThrow(
      "timed out after 25ms",
    );
  } finally {
    await silent.stop();
  }
  const exited = spawnLiveProcess(process.execPath, ["-e", fastFailure]);
  try {
    expect(await exited.waitForExit()).toBe(7);
    expect(exited.diagnostics()).toContain("startup failed");
    await expect(exited.readStdoutLine()).rejects.toThrow(
      "process exited with code 7",
    );
  } finally {
    await exited.stop();
  }
});

test.skipIf(process.platform === "win32")(
  "output readiness follows inherited pipes after the leader exits",
  async () => {
    const childScript =
      'await Bun.sleep(2_500);console.error("delayed stderr");console.log("delayed stdout")';
    const script = `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(childScript)}],{stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log(child.pid);child.unref();process.exit(0)`;
    const live = spawnLiveProcess(process.execPath, ["-e", script]);
    let descendant: number | undefined;
    try {
      descendant = Number(await live.readStdoutLine());
      const [line, match] = await Promise.all([
        live.readStdoutLine(5_000),
        live.waitForStderr(/delayed stderr/, 5_000),
      ]);
      expect(line).toBe("delayed stdout");
      expect(match[0]).toBe("delayed stderr");
      expect(await live.waitForExit()).toBe(0);
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await live.stop();
    }
  },
  10_000,
);

test("readiness rejects at the relevant stream EOF while the leader remains alive", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const script = `import { closeSync } from "node:fs";closeSync(${stream === "stdout" ? 1 : 2});await Bun.sleep(30_000)`;
    const live = spawnLiveProcess(process.execPath, ["-e", script]);
    try {
      const readiness =
        stream === "stdout"
          ? live.readStdoutLine(2_000)
          : live.waitForStderr(/never emitted/, 2_000);
      await expect(readiness).rejects.toThrow(`${stream} closed`);
      expect(live.process.exitCode).toBeNull();
    } finally {
      await live.stop();
    }
  }
});

test.skipIf(process.platform === "win32")(
  "reader failures still terminate real descendants after leader exit",
  async () => {
    const failure = new Error("injected pipe read failure");
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const actualStreams: ReadableStream<Uint8Array>[] = [];
    const streams = ["stdout", "stderr"].map(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        }),
    );
    let ready!: (value: { pid: number; url: string }) => void;
    const endpoint = new Promise<{ pid: number; url: string }>((resolve) => {
      ready = resolve;
    });
    const originalSpawn = Bun.spawn.bind(Bun);
    const spawn = spyOn(Bun, "spawn").mockImplementationOnce(((
      command: string[],
      options: Bun.Spawn.SpawnOptions<"pipe", "pipe", "pipe">,
    ) => {
      const child = originalSpawn<"pipe", "pipe", "pipe">(command, {
        ...options,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ipc(message) {
          ready(message as { pid: number; url: string });
        },
      });
      actualStreams.push(child.stdout, child.stderr);
      for (const [index, stream] of ["stdout", "stderr"].entries())
        Object.defineProperty(child, stream, { value: streams[index] });
      return child;
    }) as typeof Bun.spawn);
    const childScript =
      'process.on("SIGTERM",()=>{});const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response("alive")}});process.send({pid:process.pid,url:server.url.href})';
    const script = `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(childScript)}],{stdin:"ignore",stdout:"inherit",stderr:"inherit",ipc(message){process.send(message);child.unref();process.exit(0)}})`;
    let live: ReturnType<typeof spawnLiveProcess> | undefined;
    let descendant: number | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        live = spawnLiveProcess(process.execPath, ["-e", script]);
      } finally {
        spawn.mockRestore();
      }
      const { pid, url } = await Promise.race([
        endpoint,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Descendant endpoint did not become ready")),
            5_000,
          );
        }),
      ]);
      clearTimeout(deadline);
      descendant = pid;
      expect(await live.process.exited).toBe(0);
      expect(
        await (await fetch(url, { signal: AbortSignal.timeout(1_000) })).text(),
      ).toBe("alive");
      for (const controller of controllers) controller.error(failure);
      await expect(live.stop()).rejects.toBe(failure);
      let stopped = false;
      const until = Date.now() + 2_000;
      while (Date.now() < until && !stopped) {
        stopped = await fetch(url, { signal: AbortSignal.timeout(250) }).then(
          () => false,
          () => true,
        );
        if (!stopped) await Bun.sleep(10);
      }
      expect(stopped).toBeTrue();
    } finally {
      spawn.mockRestore();
      clearTimeout(deadline);
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      for (const controller of controllers) controller.error(failure);
      try {
        if (live)
          await live.stop().catch((error: unknown) => {
            if (error !== failure) throw error;
          });
      } finally {
        await Promise.all(actualStreams.map((stream) => stream.cancel()));
      }
    }
  },
  12_000,
);

test("HTTP startup failure closes the process and preserves diagnostics", async () => {
  await expect(
    spawnHttpMcpProcess(process.execPath, ["-e", fastFailure, "--"], {
      host: false,
    }),
  ).rejects.toThrow("startup failed");
});

test.skipIf(process.platform === "win32")(
  "live teardown kills descendants holding inherited pipes",
  async () => {
    const script = `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(stubbornDescendant)}],{stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log(child.pid);child.unref();process.exit(0)`;
    const live = spawnLiveProcess(process.execPath, ["-e", script]);
    let descendant: number | undefined;
    try {
      descendant = Number(await live.readStdoutLine());
      await live.waitForStderr(/descendant ready/);
      expect(await live.waitForExit()).toBe(0);
      // Inherited pipes close when this descendant stops; PID reaping belongs to the OS.
      await expect(live.stop()).resolves.toBeUndefined();
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await live.stop();
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "live teardown reports escaped descendants that keep pipes open",
  async () => {
    const script = `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(stubbornDescendant)}],{detached:true,stdout:"inherit",stderr:"inherit",stdin:"ignore"});console.log(child.pid);child.unref();process.exit(0)`;
    const live = spawnLiveProcess(process.execPath, ["-e", script]);
    let descendant: number | undefined;
    try {
      descendant = Number(await live.readStdoutLine());
      await live.waitForStderr(/descendant ready/);
      expect(await live.waitForExit()).toBe(0);
      await expect(live.stop()).rejects.toThrow(
        "Process pipes did not close after teardown",
      );
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
    }
  },
  7_000,
);
