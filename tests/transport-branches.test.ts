import { expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { updateHttpToml, validateHttpHost } from "../src/installer-transport";
import { runMcpCli } from "../src/mcp-cli";
import {
  createServicePlan,
  runServiceCommand,
  waitForService,
} from "../src/service";

async function listeningServer() {
  const server = createHttpServer((_request, response) => {
    response.statusCode = 400;
    response.end("ready");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  return { port: address.port, server };
}

test("reports every guarded TOML update failure and creates a missing HTTP table", () => {
  expect(() => updateHttpToml("value = [\n", { port: 4000 })).toThrow(
    "existing TOML is invalid",
  );
  expect(() => updateHttpToml("http.port = 4000\n", { port: 4001 })).toThrow(
    "dotted http.host or http.port",
  );
  expect(() =>
    updateHttpToml('[http]\nport = 4000\n[http]\nhost = "localhost"\n', {
      port: 4001,
    }),
  ).toThrow("duplicate [http] tables");
  expect(updateHttpToml("version = 1\n", { host: "localhost" })).toContain(
    '[http]\nhost = "localhost"',
  );
  expect(updateHttpToml("version = 1\n", {})).toBe("version = 1\n");
  expect(validateHttpHost("[::1]")).toBe("::1");
});

test("covers MCP parser missing, equals, hostname, and unknown-option branches", async () => {
  await expect(runMcpCli(["--transport"])).rejects.toThrow(
    "Missing value for --transport",
  );
  await expect(runMcpCli(["--unknown"])).rejects.toThrow("Unknown option");
  await expect(
    runMcpCli(["--transport=http", "--host=https://bad"]),
  ).rejects.toThrow("without a scheme or path");
  await expect(
    runMcpCli(["--transport=http", "--port=not-a-number"]),
  ).rejects.toThrow("expected an integer");
  let received: { host?: string; port?: number } | undefined;
  const server = await runMcpCli(
    ["--transport=http", "--host=127.0.0.1", "--port=4555"],
    {
      http: async (options) => {
        received = options;
        return { url: new URL("http://127.0.0.1:4555") };
      },
    },
  );
  expect(received).toEqual({ host: "127.0.0.1", port: 4555 });
  expect(server?.url.toString()).toBe("http://127.0.0.1:4555/");
  let stdioStarted = false;
  await expect(
    runMcpCli([], {
      stdio: async () => {
        stdioStarted = true;
      },
    }),
  ).resolves.toBeUndefined();
  expect(stdioStarted).toBeTrue();
});

test("renders escaped LaunchAgents and rejects unknown service platforms", () => {
  const plan = createServicePlan({
    cliEntry: "/package/with & value/dist/ast-mcp.js",
    endpoint: {
      host: "127.0.0.1",
      port: 3768,
      url: "http://127.0.0.1:3768/mcp",
    },
    home: "/Users/Test User",
    platform: "darwin",
    root: "/project/with & value",
    scope: "local",
  });
  expect(plan.content).toContain("com.mwillbanks.ast-mcp-");
  expect(plan.content).not.toContain(process.execPath);
  expect(plan.content).toContain("with &amp; value");
  expect(plan.installCommands[1]).toContain("bootstrap");
  expect(() =>
    createServicePlan({
      cliEntry: "/package/dist/ast-mcp.js",
      endpoint: {
        host: "127.0.0.1",
        port: 3768,
        url: "http://127.0.0.1:3768/mcp",
      },
      home: "/home/user",
      platform: "freebsd",
      root: "/project",
      scope: "global",
    }),
  ).toThrow("not supported on freebsd");
});

test("executes service commands and observes HTTP readiness", async () => {
  await runServiceCommand(["bun", "-e", "process.exit(0)"]);
  await runServiceCommand(["bun", "-e", "process.exit(2)"], true);
  await expect(
    runServiceCommand([
      "bun",
      "-e",
      "process.stderr.write('service failure'); process.exit(2)",
    ]),
  ).rejects.toThrow("service failure");

  const { port, server } = await listeningServer();
  try {
    await waitForService(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
