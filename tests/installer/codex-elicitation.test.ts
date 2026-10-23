import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install, update } from "../../src/installer";
import { enableCodexElicitation } from "../../src/installer/codex";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function parsed(content: string) {
  return Bun.TOML.parse(content) as Record<string, any>;
}

describe("Codex elicitation policy", () => {
  test("enables an absent policy and preserves on-request exactly", () => {
    expect(
      parsed(enableCodexElicitation("model = 'example'\n")).approval_policy,
    ).toBeUndefined();
    const content =
      "approval_policy = 'on-request' # keep\nmodel = 'example'\n";
    expect(enableCodexElicitation(content)).toBe(content);
  });

  test("enables only elicitation when never is configured", () => {
    const content =
      "approval_policy = 'never' # previous policy\nmodel = 'example'\n";
    const result = enableCodexElicitation(content);
    expect(parsed(result)).toEqual({
      approval_policy: {
        granular: {
          sandbox_approval: false,
          rules: false,
          mcp_elicitations: true,
          request_permissions: false,
          skill_approval: false,
        },
      },
      model: "example",
    });
    expect(enableCodexElicitation(result)).toBe(result);
  });

  for (const policy of [
    "approval_policy = { granular = { sandbox_approval = false, rules = true, mcp_elicitations = false, request_permissions = false, skill_approval = true } }",
    "[approval_policy.granular]\nsandbox_approval = false\nrules = true\nmcp_elicitations = false\nrequest_permissions = false\nskill_approval = true",
    '"approval_policy"."granular"."sandbox_approval" = false\napproval_policy.granular.rules = true\napproval_policy.granular.mcp_elicitations = false\napproval_policy.granular.request_permissions = false\napproval_policy.granular.skill_approval = true',
  ]) {
    test("preserves granular categories for " + policy.split("\n")[0], () => {
      const unrelated = "\n[profiles.safe]\napproval_policy = 'on-request'\n";
      const source = policy + unrelated;
      const before = parsed(source);
      const result = enableCodexElicitation(source);
      const after = parsed(result);
      expect(after).toEqual({
        ...before,
        approval_policy: {
          granular: {
            ...before.approval_policy.granular,
            mcp_elicitations: true,
          },
        },
      });
      expect(result).toContain(unrelated);
      expect(enableCodexElicitation(result)).toBe(result);
    });
  }

  test("does not mistake string content or array entries for configuration", () => {
    const content = [
      "description = '''",
      "[approval_policy.granular]",
      "mcp_elicitations = false",
      "'''",
      "values = [",
      "  '[approval_policy.granular]',",
      "  'approval_policy = never',",
      "]",
      "approval_policy = 'never'",
      "",
      "[features]",
      "example = true # keep",
      "",
    ].join("\n");
    const result = enableCodexElicitation(content);
    const before = parsed(content);
    const after = parsed(result);
    expect(after.description).toBe(before.description);
    expect(after.values).toEqual(before.values);
    expect(after.features).toEqual(before.features);
    expect(after.approval_policy.granular.mcp_elicitations).toBeTrue();
  });

  test("preserves inherited never and ignores irrelevant inherited configuration", () => {
    const result = parsed(
      enableCodexElicitation(
        "model = 'example'\n",
        "approval_policy = 'never'\n",
      ),
    );
    expect(result.approval_policy.granular.rules).toBeFalse();
    expect(result.approval_policy.granular.mcp_elicitations).toBeTrue();
    expect(() =>
      enableCodexElicitation("approval_policy = 'on-request'\n", "invalid ["),
    ).toThrow("invalid config.toml");
  });

  test("preserves legacy untrusted elicitation behavior", () => {
    const content = "approval_policy = 'untrusted'\n";
    expect(enableCodexElicitation(content)).toBe(content);
  });

  for (const source of [
    "[profiles.safe]\napproval_policy = 'never'\nmodel = 'example'\n",
    "[profiles.safe]\napproval_policy = { granular = { rules = false, mcp_elicitations = false } }\n",
    "[profiles.safe.approval_policy.granular]\nrules = false\nmcp_elicitations = false\n",
    "profiles.safe.approval_policy.granular.rules = false\nprofiles.safe.approval_policy.granular.mcp_elicitations = false\n",
    "[profiles.safe]\napproval_policy.granular.rules = false\n",
    "[profiles.safe.approval_policy.granular]\nrules = false\n",
    "[profiles.safe.approval_policy]\ngranular = { rules = false }\n",
  ]) {
    test("enables profile policy " + source.split("\n")[0], () => {
      const result = enableCodexElicitation(source);
      const profile = parsed(result).profiles.safe;
      expect(profile.approval_policy.granular.mcp_elicitations).toBeTrue();
      expect(profile.approval_policy.granular.rules).toBeFalse();
      expect(enableCodexElicitation(result)).toBe(result);
    });
  }

  test("inherits the global selected profile without changing its other categories", () => {
    const result = parsed(
      enableCodexElicitation(
        "model = 'example'\n",
        "profile = 'safe'\napproval_policy = 'on-request'\n[profiles.safe]\napproval_policy = 'never'\n",
      ),
    );
    expect(result.profiles.safe.approval_policy.granular.rules).toBeFalse();
    expect(
      result.profiles.safe.approval_policy.granular.mcp_elicitations,
    ).toBeTrue();
    expect(result.approval_policy).toBeUndefined();
  });

  test("preserves escaped basic strings while changing approval policy", () => {
    const source = [
      'description = "quoted \\"value\\" and C:\\\\tools"',
      '"escaped\\u0020key" = "unchanged"',
      "approval_policy = 'never'",
      "",
    ].join("\n");
    const before = parsed(source);
    const result = parsed(enableCodexElicitation(source));
    expect(result.description).toBe(before.description);
    expect(result["escaped key"]).toBe("unchanged");
    expect(result.approval_policy.granular.mcp_elicitations).toBeTrue();
  });

  test("adds inherited policy to an existing local profile table", () => {
    const source = [
      "model = 'local'",
      "[profiles.safe]",
      "model = 'profile-local'",
      "[profiles.inherit]",
      "model = 'inherits-root'",
      "",
    ].join("\n");
    const inherited = [
      "approval_policy = 'on-request'",
      "[profiles.safe]",
      "approval_policy = { granular = { rules = false, sandbox_approval = true, mcp_elicitations = false } }",
      "model = 'global'",
      "",
    ].join("\n");
    const result = enableCodexElicitation(source, inherited);
    expect(parsed(result)).toEqual({
      model: "local",
      profiles: {
        safe: {
          model: "profile-local",
          approval_policy: {
            granular: {
              rules: false,
              sandbox_approval: true,
              mcp_elicitations: true,
            },
          },
        },
        inherit: { model: "inherits-root" },
      },
    });
    expect(enableCodexElicitation(result, inherited)).toBe(result);
  });

  test("rejects inline profile policies without changing unrelated values", () => {
    const source =
      "profiles = { safe = { approval_policy = 'never', model = 'example' } }\n";
    expect(() => enableCodexElicitation(source)).toThrow(
      "Expand inline Codex profiles before enabling MCP elicitation",
    );
    expect(parsed(source).profiles.safe).toEqual({
      approval_policy: "never",
      model: "example",
    });
  });

  test("rejects inherited policy insertion into an inline local profile", () => {
    const source = "profiles = { safe = { model = 'local' } }\n";
    const inherited = "[profiles.safe]\napproval_policy = 'never'\n";
    expect(() => enableCodexElicitation(source, inherited)).toThrow(
      "Expand inline Codex profiles before enabling MCP elicitation",
    );
    expect(parsed(source).profiles.safe).toEqual({ model: "local" });
  });

  test("fails safely for malformed or unsupported approval settings", () => {
    for (const content of [
      "invalid [",
      "approval_policy = 'on-failure'",
      "approval_policy = false",
      "approval_policy = { granular = { rules = 'yes' } }",
    ]) {
      expect(() => enableCodexElicitation(content)).toThrow("Cannot");
    }
  });
});

describe("Codex installer elicitation", () => {
  for (const scope of ["local", "global"] as const) {
    test(
      "installs and updates " + scope + " without changing other approvals",
      async () => {
        const directory = await mkdtemp(
          path.join(os.tmpdir(), "ast-mcp-elicitation-"),
        );
        created.push(directory);
        const root = path.join(directory, "project");
        const home = path.join(directory, "home");
        const bin = path.join(home, ".bun/bin");
        await mkdir(root, { recursive: true });
        await mkdir(bin, { recursive: true });
        const alias = path.join(bin, "ast-mcp");
        await writeFile(alias, "#!/bin/sh\nexit 0\n");
        await chmod(alias, 0o755);
        const file = path.join(
          scope === "local" ? root : home,
          ".codex/config.toml",
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(
          file,
          "approval_policy = 'never'\nsandbox_mode = 'read-only'\n",
        );
        const options = {
          root,
          home,
          scope,
          targets: ["codex"] as ["codex"],
          globalBinDirectories: [bin],
          verifyLaunch: async () => {},
        };
        await install(options);
        const first = await readFile(file, "utf8");
        await update(options);
        expect(await readFile(file, "utf8")).toBe(first);
        const configuration = parsed(first);
        expect(configuration.approval_policy.granular).toEqual({
          sandbox_approval: false,
          rules: false,
          mcp_elicitations: true,
          request_permissions: false,
          skill_approval: false,
        });
        expect(configuration.sandbox_mode).toBe("read-only");
        expect(configuration.mcp_servers["ast-mcp"]).toBeDefined();
      },
    );
  }

  test("leaves malformed Codex configuration unchanged", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-invalid-codex-"),
    );
    created.push(root);
    const file = path.join(root, ".codex/config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "approval_policy = [");
    await expect(
      install({
        root,
        home: root,
        scope: "local",
        targets: ["codex"],
        verifyLaunch: async () => {},
      }),
    ).rejects.toThrow("invalid config.toml");
    expect(await readFile(file, "utf8")).toBe("approval_policy = [");
  });
});
