#!/usr/bin/env bun
const { runHook } = await import("../src/hook");
process.exit(await runHook());
