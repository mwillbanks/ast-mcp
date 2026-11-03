import { expect } from "bun:test";

import {
  exerciseSkillsRequests,
  skillsMeta,
} from "../../support/skills-protocol";
import { spawnLiveProcess } from "./live-process";

export async function exerciseSkillsStdio(executable: string, cwd: string) {
  const live = spawnLiveProcess(process.execPath, [executable, "mcp"], {
    cwd,
    timeoutMs: 30_000,
  });
  let id = 0;
  try {
    await exerciseSkillsRequests(async (method, params = {}) => {
      const requestId = ++id;
      live.process.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: { ...params, _meta: skillsMeta },
        }) + "\n",
      );
      for (;;) {
        const message = JSON.parse(await live.readStdoutLine());
        if (message.id === requestId) return message;
      }
    });
    live.process.stdin.end();
    expect(await live.waitForExit()).toBe(0);
  } finally {
    await live.stop();
  }
}
