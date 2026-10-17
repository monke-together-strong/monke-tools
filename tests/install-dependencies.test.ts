import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import { makeTempDir, writeExecutable } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function installCodiff(binDirectory: string, versionFile: string) {
  writeExecutable(
    path.join(binDirectory, "codiff"),
    `#!/bin/sh
set -eu
/bin/cat '${versionFile}'
`
  );
}

function installBrew(options: {
  afterVersion?: string;
  binDirectory: string;
  commandExit?: number;
  homebrewBinDirectory?: string;
  logPath: string;
  owned?: boolean;
  versionFile: string;
}) {
  const homebrewBinDirectory = options.homebrewBinDirectory ?? options.binDirectory;
  const codiffPath = path.join(homebrewBinDirectory, "codiff");
  mkdirSync(homebrewBinDirectory, { recursive: true });
  writeExecutable(
    path.join(options.binDirectory, "brew"),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> '${options.logPath}'
if [ "\${1:-}" = "list" ]; then
  exit ${options.owned === false ? "1" : "0"}
fi
if [ "\${1:-}" = "--prefix" ]; then
  printf '%s\n' '${path.dirname(homebrewBinDirectory)}'
  exit 0
fi
if [ "\${1:-}" = "install" ] || [ "\${1:-}" = "upgrade" ]; then
  [ ${String(options.commandExit ?? 0)} -eq 0 ] || exit ${String(options.commandExit ?? 0)}
  printf '%s\n' 'codiff v${options.afterVersion ?? "1.14.0"}' > '${options.versionFile}'
  /bin/cat > '${codiffPath}' <<'EOF'
#!/bin/sh
set -eu
/bin/cat '${options.versionFile}'
EOF
  /bin/chmod +x '${codiffPath}'
  exit 0
fi
exit 2
`
  );
}

function dependencyRuntime(options: {
  architecture?: string;
  binDirectory: string;
  platform?: NodeJS.Platform;
  toolInstallRoot?: string;
}) {
  return createTestRuntime({
    architecture: options.architecture ?? "arm64",
    cwd: options.binDirectory,
    env: {
      HOME: path.join(options.binDirectory, "home"),
      MONKE_HOME: path.join(options.binDirectory, "monke-home"),
      PATH: options.binDirectory
    },
    onStderr() {},
    onStdout() {},
    platform: options.platform ?? "darwin",
    toolInstallRoot: options.toolInstallRoot
  });
}

describe("dependency installation", () => {
  it("treats compatible Codiff as a no-op", async () => {
    const sandbox = makeTempDir("install-dependencies-compatible");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    writeFileSync(versionFile, "codiff v1.14.0\n", "utf-8");
    installCodiff(binDirectory, versionFile);
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    await runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(existsSync(brewLog)).toBeFalsy();
  });

  it("installs missing Codiff through the checksummed narrowly trusted cask", async () => {
    const sandbox = makeTempDir("install-dependencies-missing");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    await runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(readFileSync(brewLog, "utf-8")).toBe(
      "install --cask --require-sha nkzw-tech/tap/codiff\n"
    );
    expect(readFileSync(versionFile, "utf-8")).toBe("codiff v1.14.0\n");
  });

  it("resolves Codiff outside PATH from the prefix after a successful Homebrew install", async () => {
    const sandbox = makeTempDir("install-dependencies-prefix-fallback");
    const binDirectory = path.join(sandbox, "shim-bin");
    const homebrewBinDirectory = path.join(sandbox, "homebrew", "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({
      binDirectory,
      homebrewBinDirectory,
      logPath: brewLog,
      versionFile
    });

    await runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(existsSync(path.join(binDirectory, "codiff"))).toBeFalsy();
    expect(readFileSync(path.join(homebrewBinDirectory, "codiff"), "utf-8")).toContain(versionFile);
  });

  it("upgrades below-minimum Homebrew-owned Codiff", async () => {
    const sandbox = makeTempDir("install-dependencies-upgrade");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    writeFileSync(versionFile, "codiff v1.13.9\n", "utf-8");
    installCodiff(binDirectory, versionFile);
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    await runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(readFileSync(brewLog, "utf-8")).toBe(
      "list --cask nkzw-tech/tap/codiff\n--prefix\nupgrade --cask nkzw-tech/tap/codiff\n"
    );
    expect(readFileSync(versionFile, "utf-8")).toBe("codiff v1.14.0\n");
  });

  it("takes the required Codiff minimum from the running Release manifest", async () => {
    const sandbox = makeTempDir("install-dependencies-release-minimum");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    const installRoot = path.join(sandbox, "install");
    writeFileSync(versionFile, "codiff v1.14.0\n", "utf-8");
    installCodiff(binDirectory, versionFile);
    installBrew({
      afterVersion: "2.0.1",
      binDirectory,
      logPath: brewLog,
      versionFile
    });
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      path.join(installRoot, "install-manifest.json"),
      `${JSON.stringify({
        artifactDigest: "0".repeat(64),
        artifactName: "monke-tools-v2.0.0-macos-arm64.tar.gz",
        createdAt: "2026-08-21T12:34:56.000Z",
        guidanceHashes: {},
        installKind: "release",
        minimumCodiffVersion: "2.0.0",
        platform: "macos-arm64",
        releaseTag: "monke-tools-v2.0.0",
        releaseVersion: "2.0.0",
        schemaVersion: 1,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        toolBuildIdentity: "2.0.0"
      })}\n`,
      "utf-8"
    );

    await runCliAsync(
      ["install-dependencies"],
      dependencyRuntime({ binDirectory, toolInstallRoot: installRoot })
    );

    expect(readFileSync(brewLog, "utf-8")).toBe(
      "list --cask nkzw-tech/tap/codiff\n--prefix\nupgrade --cask nkzw-tech/tap/codiff\n"
    );
    expect(readFileSync(versionFile, "utf-8")).toBe("codiff v2.0.1\n");
  });

  it.each(["codiff v1.8.9\n", "not the official Codiff CLI\n"])(
    "does not automatically overwrite Codiff with unknown ownership: %j",
    async (versionOutput) => {
      const sandbox = makeTempDir("install-dependencies-unknown-owner");
      const binDirectory = path.join(sandbox, "bin");
      const versionFile = path.join(sandbox, "codiff-version");
      const brewLog = path.join(sandbox, "brew.log");
      writeFileSync(versionFile, versionOutput, "utf-8");
      installCodiff(binDirectory, versionFile);
      installBrew({ binDirectory, logPath: brewLog, owned: false, versionFile });

      await expect(
        runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }))
      ).rejects.toThrow(/not owned by Homebrew/u);

      expect(readFileSync(brewLog, "utf-8")).toBe("list --cask nkzw-tech/tap/codiff\n");
      expect(readFileSync(versionFile, "utf-8")).toBe(versionOutput);
    }
  );

  it("does not let an installed cask claim a PATH-shadowing Codiff", async () => {
    const sandbox = makeTempDir("install-dependencies-shadowed");
    const shadowBin = path.join(sandbox, "shadow", "bin");
    const homebrewBin = path.join(sandbox, "homebrew", "bin");
    const shadowVersionFile = path.join(sandbox, "shadow-version");
    const homebrewVersionFile = path.join(sandbox, "homebrew-version");
    const brewLog = path.join(sandbox, "brew.log");
    writeFileSync(shadowVersionFile, "codiff v1.8.9\n", "utf-8");
    writeFileSync(homebrewVersionFile, "codiff v1.14.0\n", "utf-8");
    installCodiff(shadowBin, shadowVersionFile);
    installCodiff(homebrewBin, homebrewVersionFile);
    installBrew({
      binDirectory: homebrewBin,
      logPath: brewLog,
      versionFile: homebrewVersionFile
    });

    await expect(
      runCliAsync(
        ["install-dependencies"],
        createTestRuntime({
          architecture: "arm64",
          cwd: sandbox,
          env: { PATH: `${shadowBin}:${homebrewBin}` },
          onStderr() {},
          onStdout() {},
          platform: "darwin"
        })
      )
    ).rejects.toThrow(/not owned by Homebrew/u);

    expect(readFileSync(brewLog, "utf-8")).toBe("list --cask nkzw-tech/tap/codiff\n--prefix\n");
    expect(readFileSync(shadowVersionFile, "utf-8")).toBe("codiff v1.8.9\n");
  });

  it("produces retryable guidance when Homebrew is missing", async () => {
    const sandbox = makeTempDir("install-dependencies-no-brew");
    const binDirectory = path.join(sandbox, "bin");
    mkdirSync(binDirectory, { recursive: true });

    await expect(
      runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }))
    ).rejects.toThrow(/Homebrew is unavailable.*mt install-dependencies/u);
  });

  it("reports Homebrew failure without accepting the dependency", async () => {
    const sandbox = makeTempDir("install-dependencies-brew-failure");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({ binDirectory, commandExit: 23, logPath: brewLog, versionFile });

    await expect(
      runCliAsync(["install-dependencies"], dependencyRuntime({ binDirectory }))
    ).rejects.toThrow(/Homebrew Codiff reconciliation failed/u);
    expect(existsSync(path.join(binDirectory, "codiff"))).toBeFalsy();
  });

  it("never invokes Homebrew on non-macOS platforms", async () => {
    const sandbox = makeTempDir("install-dependencies-linux");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    await runCliAsync(
      ["install-dependencies"],
      dependencyRuntime({ architecture: "x64", binDirectory, platform: "linux" })
    );

    expect(existsSync(brewLog)).toBeFalsy();
    expect(existsSync(path.join(binDirectory, "codiff"))).toBeFalsy();
  });
});
