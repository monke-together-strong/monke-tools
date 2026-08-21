import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { runCli } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeTempDir, writeExecutable } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

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
  logPath: string;
  owned?: boolean;
  versionFile: string;
}) {
  const codiffPath = path.join(options.binDirectory, "codiff");
  writeExecutable(
    path.join(options.binDirectory, "brew"),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> '${options.logPath}'
if [ "\${1:-}" = "list" ]; then
  exit ${options.owned === false ? "1" : "0"}
fi
if [ "\${1:-}" = "install" ] || [ "\${1:-}" = "upgrade" ]; then
  [ ${String(options.commandExit ?? 0)} -eq 0 ] || exit ${String(options.commandExit ?? 0)}
  printf '%s\n' 'codiff v${options.afterVersion ?? "1.10.1"}' > '${options.versionFile}'
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
  return createRuntime({
    architecture: options.architecture ?? "arm64",
    cwd: options.binDirectory,
    env: { PATH: options.binDirectory },
    onStderr() {},
    onStdout() {},
    platform: options.platform ?? "darwin",
    toolInstallRoot: options.toolInstallRoot
  });
}

describe("dependency installation", () => {
  test("Brewfile declares the narrowly trusted Codiff cask", () => {
    expect(readFileSync(path.join(projectRoot, "Brewfile"), "utf-8")).toBe(
      'cask_args require_sha: true\ncask "nkzw-tech/tap/codiff", greedy: true, trusted: true\n'
    );
  });

  test("compatible Codiff is a no-op", () => {
    const sandbox = makeTempDir("install-dependencies-compatible");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    writeFileSync(versionFile, "codiff v1.10.1\n", "utf-8");
    installCodiff(binDirectory, versionFile);
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    runCli(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(existsSync(brewLog)).toBeFalsy();
  });

  test("missing Codiff is installed through the checksummed narrowly trusted cask", () => {
    const sandbox = makeTempDir("install-dependencies-missing");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    runCli(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(readFileSync(brewLog, "utf-8")).toBe(
      "install --cask --require-sha nkzw-tech/tap/codiff\n"
    );
    expect(readFileSync(versionFile, "utf-8")).toBe("codiff v1.10.1\n");
  });

  test("below-minimum Homebrew-owned Codiff is upgraded", () => {
    const sandbox = makeTempDir("install-dependencies-upgrade");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    writeFileSync(versionFile, "codiff v1.8.9\n", "utf-8");
    installCodiff(binDirectory, versionFile);
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    runCli(["install-dependencies"], dependencyRuntime({ binDirectory }));

    expect(readFileSync(brewLog, "utf-8")).toBe(
      "list --cask nkzw-tech/tap/codiff\nupgrade --cask nkzw-tech/tap/codiff\n"
    );
    expect(readFileSync(versionFile, "utf-8")).toBe("codiff v1.10.1\n");
  });

  test("the running Release manifest supplies the required Codiff minimum", () => {
    const sandbox = makeTempDir("install-dependencies-release-minimum");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    const installRoot = path.join(sandbox, "install");
    writeFileSync(versionFile, "codiff v1.10.1\n", "utf-8");
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

    runCli(
      ["install-dependencies"],
      dependencyRuntime({ binDirectory, toolInstallRoot: installRoot })
    );

    expect(readFileSync(brewLog, "utf-8")).toBe(
      "list --cask nkzw-tech/tap/codiff\nupgrade --cask nkzw-tech/tap/codiff\n"
    );
    expect(readFileSync(versionFile, "utf-8")).toBe("codiff v2.0.1\n");
  });

  test.each(["codiff v1.8.9\n", "not the official Codiff CLI\n"])(
    "Codiff with unknown ownership is not overwritten automatically: %j",
    (versionOutput) => {
      const sandbox = makeTempDir("install-dependencies-unknown-owner");
      const binDirectory = path.join(sandbox, "bin");
      const versionFile = path.join(sandbox, "codiff-version");
      const brewLog = path.join(sandbox, "brew.log");
      writeFileSync(versionFile, versionOutput, "utf-8");
      installCodiff(binDirectory, versionFile);
      installBrew({ binDirectory, logPath: brewLog, owned: false, versionFile });

      expect(() => {
        runCli(["install-dependencies"], dependencyRuntime({ binDirectory }));
      }).toThrow(/not owned by Homebrew/u);

      expect(readFileSync(brewLog, "utf-8")).toBe("list --cask nkzw-tech/tap/codiff\n");
      expect(readFileSync(versionFile, "utf-8")).toBe(versionOutput);
    }
  );

  test("missing Homebrew produces retryable guidance", () => {
    const sandbox = makeTempDir("install-dependencies-no-brew");
    const binDirectory = path.join(sandbox, "bin");
    mkdirSync(binDirectory, { recursive: true });

    expect(() => {
      runCli(["install-dependencies"], dependencyRuntime({ binDirectory }));
    }).toThrow(/Homebrew is unavailable.*mt install-dependencies/u);
  });

  test("Homebrew failure is reported without accepting the dependency", () => {
    const sandbox = makeTempDir("install-dependencies-brew-failure");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({ binDirectory, commandExit: 23, logPath: brewLog, versionFile });

    expect(() => {
      runCli(["install-dependencies"], dependencyRuntime({ binDirectory }));
    }).toThrow(/Homebrew Codiff reconciliation failed/u);
    expect(existsSync(path.join(binDirectory, "codiff"))).toBeFalsy();
  });

  test("non-macOS platforms never invoke Homebrew", () => {
    const sandbox = makeTempDir("install-dependencies-linux");
    const binDirectory = path.join(sandbox, "bin");
    const versionFile = path.join(sandbox, "codiff-version");
    const brewLog = path.join(sandbox, "brew.log");
    installBrew({ binDirectory, logPath: brewLog, versionFile });

    runCli(
      ["install-dependencies"],
      dependencyRuntime({ architecture: "x64", binDirectory, platform: "linux" })
    );

    expect(existsSync(brewLog)).toBeFalsy();
    expect(existsSync(path.join(binDirectory, "codiff"))).toBeFalsy();
  });
});
