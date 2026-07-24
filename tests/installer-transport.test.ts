import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type InstallOptions, install, update } from "../src/installer";
import {
  httpEndpoint,
  updateHttpToml,
  validateHttpHost,
  validateHttpPort,
} from "../src/installer-transport";
import { createServicePlan, serviceIdentity } from "../src/service";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function temporary(prefix: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(folder);
  return folder;
}

describe("HTTP endpoint configuration", () => {
  test("normalizes wildcard and IPv6 client URLs", () => {
    expect(httpEndpoint("0.0.0.0", 3768).url).toBe("http://127.0.0.1:3768/mcp");
    expect(httpEndpoint("::", 3768).url).toBe("http://[::1]:3768/mcp");
    expect(httpEndpoint("[2001:db8::1]", 8443).url).toBe(
      "http://[2001:db8::1]:8443/mcp",
    );
  });

  test("rejects schemes, paths, and invalid ports", () => {
    expect(() => validateHttpHost("https://localhost")).toThrow(
      "without a scheme",
    );
    expect(() => validateHttpHost("localhost/path")).toThrow(
      "without a scheme",
    );
    expect(() => validateHttpPort(0)).toThrow("1 through 65535");
    expect(() => validateHttpPort(65_536)).toThrow("1 through 65535");
  });

  test("updates only explicit HTTP fields while preserving surrounding TOML", () => {
    const original = `# user comment\nversion = 1\n\n[http]\nhost = "localhost" # old\n\n[safety]\nrequire_hash = true\n`;
    const updated = updateHttpToml(original, { host: "127.0.0.1", port: 4567 });
    expect(updated).toContain("# user comment");
    expect(updated).toContain("# old");
    expect(updated).toContain('host = "127.0.0.1"');
    expect(updated).toContain("port = 4567");
    expect(updated).toContain("[safety]\nrequire_hash = true");
    expect(Bun.TOML.parse(updated)).toMatchObject({
      http: { host: "127.0.0.1", port: 4567 },
      safety: { require_hash: true },
    });
  });
});

describe("installer HTTP transport", () => {
  test("generates native HTTP definitions for every local host and persists explicit settings", async () => {
    const root = await temporary("ast-mcp-http-install-");
    await writeFile(path.join(root, "ast-mcp.toml"), "# retained\n");
    const options: InstallOptions = {
      host: "127.0.0.1",
      port: 4567,
      root,
      scope: "local",
      targets: ["codex", "claude", "copilot"],
      transport: "http",
    };
    await install(options);

    const codex = await readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(codex).toContain('url = "http://127.0.0.1:4567/mcp"');
    expect(codex).not.toContain('command = "bun"');
    const claude = JSON.parse(
      await readFile(path.join(root, ".mcp.json"), "utf8"),
    );
    expect(claude.mcpServers["ast-mcp"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4567/mcp",
    });
    const copilot = JSON.parse(
      await readFile(path.join(root, ".github/mcp.json"), "utf8"),
    );
    expect(copilot.mcpServers["ast-mcp"]).toEqual({
      tools: ["*"],
      type: "http",
      url: "http://127.0.0.1:4567/mcp",
    });
    const vscode = JSON.parse(
      await readFile(path.join(root, ".vscode/mcp.json"), "utf8"),
    );
    expect(vscode.servers["ast-mcp"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4567/mcp",
    });
    const config = await readFile(path.join(root, "ast-mcp.toml"), "utf8");
    expect(config).toContain("# retained");
    expect(config).toContain("port = 4567");

    await update({ root, scope: "local", targets: ["codex"] });
    expect(
      await readFile(path.join(root, ".codex/config.toml"), "utf8"),
    ).toContain('url = "http://127.0.0.1:4567/mcp"');
  });

  test("keeps stdio as the default and validates incompatible options before host writes", async () => {
    const root = await temporary("ast-mcp-stdio-default-");
    await install({ root, scope: "local", targets: ["codex"] });
    expect(
      await readFile(path.join(root, ".codex/config.toml"), "utf8"),
    ).toContain('command = "bun"');

    const invalid = await temporary("ast-mcp-http-invalid-");
    await expect(
      install({
        host: "127.0.0.1",
        root: invalid,
        scope: "local",
        targets: ["codex"],
      }),
    ).rejects.toThrow("require --transport http");
    await expect(
      access(path.join(invalid, ".codex/config.toml")),
    ).rejects.toThrow();
  });

  test("renders and manages Linux user services through an injected runner", async () => {
    const root = await temporary("ast-mcp-service-root-");
    const home = await temporary("ast-mcp-service-home-");
    const commands: string[][] = [];
    const options: InstallOptions = {
      home,
      platform: "linux",
      port: 4789,
      root,
      scope: "local",
      service: true,
      serviceRunner: async (command) => {
        commands.push(command);
      },
      targets: ["codex"],
      transport: "http",
    };
    await install(options);
    const plan = createServicePlan({
      cliEntry: path.resolve("dist/ast-mcp.js"),
      endpoint: httpEndpoint("127.0.0.1", 4789),
      home,
      platform: "linux",
      root,
      scope: "local",
    });
    const unit = await readFile(plan.file, "utf8");
    expect(unit).toContain('--transport" "http');
    expect(unit).toContain(process.execPath);
    expect(unit).toContain(`AST_MCP_PROJECT_ROOT=${root}`);
    expect(commands.some((command) => command.includes("enable"))).toBeTrue();

    await update({ ...options, service: false });
    await expect(access(plan.file)).rejects.toThrow();
    expect(commands.some((command) => command.includes("disable"))).toBeTrue();
    expect(
      commands.filter((command) => command.includes("daemon-reload")),
    ).toHaveLength(2);
  });
});

test("service identities are stable per normalized project and platform plans are explicit", () => {
  expect(serviceIdentity("global", "/one")).toBe("ast-mcp");
  expect(serviceIdentity("local", "/one")).toBe(
    serviceIdentity("local", "/one/../one"),
  );
  expect(serviceIdentity("local", "/one")).not.toBe(
    serviceIdentity("local", "/two"),
  );
  expect(() =>
    createServicePlan({
      cliEntry: "/package/dist/ast-mcp.js",
      endpoint: httpEndpoint("127.0.0.1", 3768),
      home: "/home/user",
      platform: "win32",
      root: "/project",
      scope: "local",
    }),
  ).toThrow("not supported on Windows");
});
