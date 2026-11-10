import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withCheckoutAdmission } from "../../src/runtime/checkout-admission.ts";
import { acquireTransactionLock } from "../../src/runtime/transaction-lock.ts";

const admissionUrl = new URL(
  "../../src/runtime/checkout-admission.ts",
  import.meta.url,
).href;

function contender(checkout: string, label: string) {
  const script = `
    import { appendFile } from "node:fs/promises";
    import { withCheckoutAdmission } from ${JSON.stringify(admissionUrl)};
    const checkout = ${JSON.stringify(checkout)};
    await withCheckoutAdmission(checkout, { deadline: Date.now() + 10000 },
      async () => appendFile(checkout + ".order", ${JSON.stringify(label + "\n")}));
  `;
  return Bun.spawn([process.execPath, "--eval", script], {
    stdout: "ignore",
    stderr: "pipe",
  });
}

async function observeTickets(checkout: string, count: number) {
  const directory = checkout + ".admission";
  let changed = Promise.withResolvers<void>();
  const signal = AbortSignal.timeout(5000);
  const wake = () => changed.resolve();
  const watcher = watch(directory, { persistent: false }, wake);
  signal.addEventListener("abort", wake);
  try {
    while (true) {
      signal.throwIfAborted();
      if ((await readdir(directory)).length === count) return;
      await changed.promise;
      changed = Promise.withResolvers<void>();
    }
  } finally {
    watcher.close();
    signal.removeEventListener("abort", wake);
  }
}

test("checkout admission preserves published order across Bun processes and removes a cancelled waiter", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkout-admission-"));
  const checkout = path.join(directory, "checkout");
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const options = { deadline: Date.now() + 10_000 };
  const owner = withCheckoutAdmission(checkout, options, async () => {
    entered.resolve();
    await release.promise;
    await appendFile(checkout + ".order", "owner\n");
  });
  const children: ReturnType<typeof contender>[] = [];
  try {
    await Promise.race([owner, entered.promise]);
    children.push(contender(checkout, "first"));
    await observeTickets(checkout, 2);

    const cancelled = withCheckoutAdmission(
      checkout,
      { ...options, signal: controller.signal },
      async () => "entered unexpectedly",
    ).catch((error: unknown) => error);
    await observeTickets(checkout, 3);

    children.push(contender(checkout, "second"));
    await observeTickets(checkout, 4);
    controller.abort();
    expect(await cancelled).toMatchObject({ code: "lock_aborted" });
    await observeTickets(checkout, 3);
    expect(
      await withCheckoutAdmission(
        path.join(directory, "other"),
        options,
        async () => "independent",
      ),
    ).toBe("independent");

    release.resolve();
    await owner;
    for (const child of children) {
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
    }
    expect(await Bun.file(checkout + ".order").text()).toBe(
      "owner\nfirst\nsecond\n",
    );
    expect(await readdir(checkout + ".admission")).toEqual([]);
  } finally {
    controller.abort();
    release.resolve();
    await owner.catch(() => undefined);
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkout admission reaps a ticket left by a dead process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkout-admission-"));
  const checkout = path.join(directory, "checkout");
  const script = `
    import { withCheckoutAdmission } from ${JSON.stringify(admissionUrl)};
    await withCheckoutAdmission(${JSON.stringify(checkout)}, { deadline: Date.now() + 10000 },
      async () => {
        console.log("entered");
        await new Response(Bun.stdin.stream()).text();
      });
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = child.stdout.getReader();
  try {
    const first = await output.read();
    expect(new TextDecoder().decode(first.value).trim()).toBe("entered");
    expect(await readdir(checkout + ".admission")).toHaveLength(1);
    child.kill("SIGKILL");
    await child.exited;
    expect(
      await withCheckoutAdmission(
        checkout,
        { deadline: Date.now() + 10_000 },
        async () => "recovered",
      ),
    ).toBe("recovered");
    expect(await readdir(checkout + ".admission")).toEqual([]);
  } finally {
    output.releaseLock();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("reaping an expired ticket cannot preempt its transaction guard", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkout-admission-"));
  const checkout = path.join(directory, "checkout");
  const guard = await acquireTransactionLock(checkout);
  const queue = checkout + ".admission";
  try {
    await mkdir(queue, { mode: 0o700 });
    const expiredTicket = `000000000001-${process.pid}-1-${randomUUID()}`;
    await Bun.write(path.join(queue, expiredTicket), "");
    await expect(
      withCheckoutAdmission(
        checkout,
        { deadline: Date.now() + 10_000 },
        async () => {
          const contender = await acquireTransactionLock(checkout, {
            tryOnly: true,
          });
          contender.release();
        },
      ),
    ).rejects.toMatchObject({ code: "lock_busy" });
    guard.fence();
    expect(await readdir(queue)).toEqual([]);
  } finally {
    guard.release();
    await rm(directory, { recursive: true, force: true });
  }
});
