import { hash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runCliAsync } from "../src/index.ts";
import { write, writeGlobalInstructionsSource } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";
import type { TestRuntimeOptions } from "./runtime-fixture.ts";

export function prepareSource(sourceCheckout: string) {
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n"
  );
  writeGlobalInstructionsSource(sourceCheckout);
  write(sourceCheckout, "skills/references/internal/README.md", "Reference guidance.\n");
}

export function prepareStagedInstall(monkeHome: string, installId: string) {
  const stagedInstall = path.join(monkeHome, "install-staging", installId);
  mkdirSync(stagedInstall, { recursive: true });
  const executable = path.join(stagedInstall, "mt");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(executable, 0o755);
  return stagedInstall;
}

export function prepareReleaseBundle(
  sandbox: string,
  options: { platform?: "linux-x64" | "macos-arm64" } = {}
) {
  const bundleRoot = path.join(sandbox, "bundle");
  const platform = options.platform ?? "linux-x64";
  const skillContents = "---\nname: example\n---\n";
  const referenceContents = "Release reference.\n";
  write(bundleRoot, "skills/internal/example/SKILL.md", skillContents);
  write(bundleRoot, "skills/references/internal/example.md", referenceContents);
  write(bundleRoot, "instructions/GLOBAL.md", "Release baseline.\n");
  write(bundleRoot, "skills/codex/.keep", "\n");
  write(bundleRoot, "skills/imported/.keep", "\n");
  write(bundleRoot, "install.sh", "#!/bin/sh\nexit 0\n");
  const executableContents = "#!/bin/sh\nprintf '1.2.3\\n'\n";
  write(bundleRoot, "mt", executableContents);
  chmodSync(path.join(bundleRoot, "install.sh"), 0o755);
  chmodSync(path.join(bundleRoot, "mt"), 0o755);
  const manifest = {
    artifactDigest: hash("sha256", executableContents, "hex"),
    artifactName: `monke-tools-v1.2.3-${platform}.tar.gz`,
    createdAt: "2026-08-21T12:34:56.000Z",
    guidanceHashes: {
      "instructions/GLOBAL.md": hash("sha256", "Release baseline.\n", "hex"),
      "skills/codex/.keep": hash("sha256", "\n", "hex"),
      "skills/imported/.keep": hash("sha256", "\n", "hex"),
      "skills/internal/example/SKILL.md": hash("sha256", skillContents, "hex"),
      "skills/references/internal/example.md": hash("sha256", referenceContents, "hex")
    },
    installKind: "release",
    minimumCodiffVersion: "1.9.0",
    platform,
    releaseTag: "monke-tools-v1.2.3",
    releaseVersion: "1.2.3",
    schemaVersion: 1,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    toolBuildIdentity: "1.2.3"
  } as const;
  write(bundleRoot, "install-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { bundleRoot, manifest };
}

export async function activateLocal(options: {
  dirty?: boolean;
  executableMode?: number;
  home: string;
  installId: string;
  monkeHome: string;
  onMutationOutput?: () => void;
  sourceCheckout: string;
  targetKinds?: string[];
}) {
  const stagedInstall = prepareStagedInstall(options.monkeHome, options.installId);
  if (options.executableMode !== undefined) {
    chmodSync(path.join(stagedInstall, "mt"), options.executableMode);
  }
  const args = [
    "activate-local-install",
    stagedInstall,
    options.sourceCheckout,
    "--install-id",
    options.installId,
    "--source-commit",
    "0123456789abcdef0123456789abcdef01234567",
    "--created-at",
    "2026-08-20T12:34:56.000Z",
    "--platform",
    "darwin-arm64"
  ];
  const targetKinds = options.targetKinds ?? ["codex"];
  if (targetKinds.length > 0) {
    args.push("--targets", ...targetKinds);
  }
  if (options.dirty === true) {
    args.push("--dirty");
  }

  await runCliAsync(
    args,
    createTestRuntime({
      architecture: "x64",
      cwd: options.sourceCheckout,
      env: {
        CODEX_HOME: path.join(options.home, ".codex"),
        HOME: options.home,
        MONKE_HOME: options.monkeHome,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh"
      },
      onStderr() {
        options.onMutationOutput?.();
      },
      onStdout() {
        // Intentionally ignore command output.
      },
      platform: "linux",
      toolBuildIdentity: options.dirty ? "local+0123456-dirty" : "local+0123456"
    })
  );
}

export function activateRelease(options: {
  args?: string[];
  bundleRoot: string;
  home: string;
  monkeHome: string;
  runtime?: TestRuntimeOptions;
  sandbox: string;
}) {
  const runtimeOptions = options.runtime ?? {};
  return runCliAsync(
    ["activate-release-install", options.bundleRoot, ...(options.args ?? [])],
    createTestRuntime({
      architecture: "x64",
      onStderr() {
        // Intentionally ignore command output.
      },
      onStdout() {
        // Intentionally ignore command output.
      },
      platform: "linux",
      toolBuildIdentity: "1.2.3",
      ...runtimeOptions,
      cwd: options.sandbox,
      env: {
        CODEX_HOME: path.join(options.home, ".codex"),
        HOME: options.home,
        MONKE_HOME: options.monkeHome,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        ...runtimeOptions.env
      }
    })
  );
}
