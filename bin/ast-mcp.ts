#!/usr/bin/env bun
process.exit((await (await import("../src/cli")).runCli()) ?? 0);
