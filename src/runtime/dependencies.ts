import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(
  import.meta.dir,
  path.basename(import.meta.dir) === "dist" ? ".." : "../..",
);

const astBroWrapper = path.join(PACKAGE_ROOT, "node_modules/.bin/ast-bro");
const astBroInstaller = createRequire(import.meta.url)(
  path.join(path.dirname(realpathSync(astBroWrapper)), "install.js"),
) as { getBinaryPath: () => string };

export const AST_BRO_VERSION = "3.0.0";
export const AST_BRO_BINARY =
  process.env.AST_BRO_BINARY ?? astBroInstaller.getBinaryPath();

export function assertAstBroAvailable(
  binary = AST_BRO_BINARY,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): void {
  let version = "";
  let cause = "binary not found";
  try {
    const result = Bun.spawnSync([binary, "--version"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    version = result.stdout.toString().trim();
    if (result.exitCode === 0 && version === `ast-bro ${AST_BRO_VERSION}`)
      return;
    cause = result.stderr.toString().trim() || version || cause;
  } catch (error) {
    cause = error instanceof Error ? error.message : String(error);
  }
  const environment =
    platform === "win32"
      ? `$env:AST_BRO_BINARY = "$HOME\\.cargo\\bin\\ast-bro.exe"\n[Environment]::SetEnvironmentVariable("AST_BRO_BINARY", "$HOME\\.cargo\\bin\\ast-bro.exe", "User")`
      : `export AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"\nprintf '%s\\n' 'export AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"' >> "$HOME/.profile"\n# For zsh login shells, persist the same line in "$HOME/.zprofile" instead.`;
  const packageRecovery =
    platform === "darwin" && arch === "arm64"
      ? "The npm package includes a macOS Apple Silicon binary. If Bun blocked its installer, run:\n  bun pm trust @ast-bro/cli\nThen rerun ast-mcp install."
      : `No precompiled ast-bro ${AST_BRO_VERSION} binary is published for ${platform}-${arch}. Install Rust from https://rustup.rs, then run:`;

  throw new Error(
    `ast-bro ${AST_BRO_VERSION} is required before ast-mcp can configure a host.\nResolved binary: ${binary}\nFailure: ${cause}\n\n${packageRecovery}\n  cargo install ast-bro --version ${AST_BRO_VERSION} --locked\n\nSet AST_BRO_BINARY before rerunning the installer and persist it for the host process:\n${environment}\n\nRestart the host after installation so it receives the environment variable. GUI-launched hosts must be started from that configured environment or receive AST_BRO_BINARY through their launcher.`,
  );
}

export const DPRINT_BINARY =
  process.env.DPRINT_BINARY ??
  path.join(PACKAGE_ROOT, "node_modules/.bin/dprint");
