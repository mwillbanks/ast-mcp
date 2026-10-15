import { env as processEnv, execPath, exit } from "node:process";
for (const [index, basePath] of ["/", "/ast-mcp/"].entries()) {
  const env = {
    ...processEnv,
    BASE_PATH: basePath,
    TEST_PORT: String(4173 + index),
  };
  for (const command of [
    ["run", "build"],
    ["run", "--bun", "playwright", "test"],
  ]) {
    const child = Bun.spawn([execPath, ...command], {
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) exit(code);
  }
}
