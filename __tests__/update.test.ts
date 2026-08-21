import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeTempDir, write, writeExecutable } from "./helpers.ts";

const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex");
}

function prepareActiveRelease(monkeHome: string, version: string, activate = true) {
  const installRoot = path.join(monkeHome, "installs", `release-${version}-linux-x64`);
  const guidance = {
    "skills/codex/.keep": "\n",
    "skills/imported/.keep": "\n",
    "skills/internal/example/SKILL.md": "---\nname: example\n---\n",
    "skills/references/internal/example.md": "Release reference.\n"
  };
  for (const [filePath, contents] of Object.entries(guidance)) {
    write(installRoot, filePath, contents);
  }
  write(
    installRoot,
    "install-manifest.json",
    `${JSON.stringify({
      artifactName: `monke-tools-v${version}-linux-x64.tar.gz`,
      guidanceHashes: Object.fromEntries(
        Object.entries(guidance).map(([filePath, contents]) => [filePath, sha256(contents)])
      ),
      installKind: "release",
      minimumCodiffVersion: "1.9.0",
      platform: "linux-x64",
      releaseTag: `monke-tools-v${version}`,
      releaseVersion: version,
      schemaVersion: 1,
      sourceCommit: SOURCE_COMMIT,
      toolBuildIdentity: version
    })}\n`
  );
  if (activate) {
    mkdirSync(monkeHome, { recursive: true });
    symlinkSync(path.relative(monkeHome, installRoot), path.join(monkeHome, "current"), "dir");
  }
  return installRoot;
}

function prepareActiveLocal(monkeHome: string, sourceCheckout: string) {
  const installRoot = path.join(monkeHome, "installs", "local-dirty");
  writeExecutable(path.join(installRoot, "mt"), "#!/bin/sh\nexit 0\n");
  write(
    installRoot,
    "install-manifest.json",
    `${JSON.stringify({
      createdAt: "2026-08-21T12:34:56.000Z",
      createdBy: "bun run install:local",
      installId: "local-dirty",
      installKind: "local",
      minimumCodiffVersion: "1.9.0",
      platform: "linux-x64",
      schemaVersion: 1,
      sourceCheckout,
      sourceCommit: SOURCE_COMMIT,
      sourceDirty: true,
      toolBuildIdentity: "local+0123456-dirty"
    })}\n`
  );
  mkdirSync(monkeHome, { recursive: true });
  symlinkSync(path.relative(monkeHome, installRoot), path.join(monkeHome, "current"), "dir");
  return installRoot;
}

function release(version: string, options: { draft?: boolean; prerelease?: boolean } = {}) {
  const tag = `monke-tools-v${version}`;
  return {
    assets: [
      {
        browser_download_url: `https://github.com/monke-together-strong/monke-tools/releases/download/${tag}/${tag}-linux-x64.tar.gz`,
        digest: `sha256:${"a".repeat(64)}`,
        name: `${tag}-linux-x64.tar.gz`
      },
      {
        browser_download_url: `https://github.com/monke-together-strong/monke-tools/releases/download/${tag}/${tag}-checksums.txt`,
        digest: `sha256:${"b".repeat(64)}`,
        name: `${tag}-checksums.txt`
      }
    ],
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    tag_name: tag,
    target_commitish: SOURCE_COMMIT
  };
}

function prepareReleaseAsset(
  sandbox: string,
  version: string,
  options: { manifestSourceCommit?: string } = {}
) {
  const tag = `monke-tools-v${version}`;
  const archiveName = `${tag}-linux-x64.tar.gz`;
  const checksumsName = `${tag}-checksums.txt`;
  const bundleRoot = path.join(sandbox, `bundle-${version}`);
  const guidance = {
    "skills/codex/.keep": "\n",
    "skills/imported/.keep": "\n",
    "skills/internal/example/SKILL.md": `---\nname: example-${version}\n---\n`,
    "skills/references/internal/example.md": `Release ${version} reference.\n`
  };
  for (const [filePath, contents] of Object.entries(guidance)) {
    write(bundleRoot, filePath, contents);
  }
  write(bundleRoot, "instructions/GLOBAL.md", `Release ${version} baseline.\n`);
  writeExecutable(path.join(bundleRoot, "install.sh"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(bundleRoot, "mt"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  const manifest = {
    artifactName: archiveName,
    guidanceHashes: Object.fromEntries(
      Object.entries(guidance).map(([filePath, contents]) => [filePath, sha256(contents)])
    ),
    installKind: "release",
    minimumCodiffVersion: "1.9.0",
    platform: "linux-x64",
    releaseTag: tag,
    releaseVersion: version,
    schemaVersion: 1,
    sourceCommit: options.manifestSourceCommit ?? SOURCE_COMMIT,
    toolBuildIdentity: version
  };
  write(bundleRoot, "install-manifest.json", `${JSON.stringify(manifest)}\n`);
  const archivePath = path.join(sandbox, archiveName);
  const tar = Bun.spawnSync({ cmd: ["tar", "-czf", archivePath, "-C", bundleRoot, "."] });
  expect(tar.exitCode).toBe(0);
  const archive = new Uint8Array(readFileSync(archivePath));
  const checksums = new TextEncoder().encode(`${sha256Bytes(archive)}  ${archiveName}\n`);
  const metadata = release(version);
  const [archiveAsset, checksumsAsset] = metadata.assets;
  if (!archiveAsset || !checksumsAsset) {
    throw new Error("Release test fixture assets are missing");
  }
  archiveAsset.digest = `sha256:${sha256Bytes(archive)}`;
  checksumsAsset.digest = `sha256:${sha256Bytes(checksums)}`;
  return { archive, archiveName, checksums, checksumsName, manifest, metadata };
}

function sha256Bytes(contents: Uint8Array) {
  return createHash("sha256").update(contents).digest("hex");
}

describe("Release update", () => {
  test("check reports the highest compatible stable Release without changing installation", async () => {
    const sandbox = makeTempDir("release-update-check");
    const monkeHome = path.join(sandbox, "monke-home");
    prepareActiveRelease(monkeHome, "1.2.3");
    let stderr = "";

    await runCliAsync(
      ["update", "--check"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { FORCE_COLOR: "1", HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr(text) {
          stderr += text;
        },
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("check must not download Release assets");
          },
          async listReleases(page) {
            if (page === 1) {
              return [
                { ...release("99.0.0"), tag_name: "@monke/other@99.0.0" },
                release("9.0.0", { draft: true }),
                release("2.0.0", { prerelease: true }),
                release("1.2.4")
              ];
            }
            return [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: path.join(monkeHome, "installs", "release-1.2.3-linux-x64")
      })
    );

    expect(stderr).toContain("Release update available: 1.2.3 -> 1.2.4");
    expect(stderr).not.toContain("Checking the stable");
    expect(stderr).not.toContain("\u001B[");
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
    expect(existsSync(path.join(monkeHome, "install-staging"))).toBeFalsy();
  });

  test("interactive checks show colored progress while redirected output stays stable", async () => {
    const sandbox = makeTempDir("release-update-tty");
    const monkeHome = path.join(sandbox, "monke-home");
    const installRoot = prepareActiveRelease(monkeHome, "1.2.3");
    let stderr = "";

    await runCliAsync(
      ["update", "--check"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: {
          FORCE_COLOR: "1",
          HOME: path.join(sandbox, "home"),
          MONKE_HOME: monkeHome,
          NO_COLOR: undefined
        },
        onStderr(text) {
          stderr += text;
        },
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("check must not download Release assets");
          },
          async listReleases(page) {
            return page === 1 ? [release("1.2.4")] : [];
          }
        },
        stderrIsTTY: true,
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: installRoot
      })
    );

    expect(stderr).toContain("Checking the stable monke-tools Release catalog");
    expect(stderr).toContain("\u001B[");
  });

  test("update verifies and atomically activates a complete Release while retaining its predecessor", async () => {
    const sandbox = makeTempDir("release-update-activate");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const predecessor = prepareActiveRelease(monkeHome, "1.2.3");
    const olderInstall = prepareActiveRelease(monkeHome, "1.2.2", false);
    const candidate = prepareReleaseAsset(sandbox, "1.2.4");
    const stagingRoot = path.join(monkeHome, "install-staging");
    mkdirSync(path.join(stagingRoot, "update-interrupted"), { recursive: true });
    mkdirSync(path.join(stagingRoot, "release-interrupted"), { recursive: true });
    mkdirSync(path.join(stagingRoot, "manual-not-managed"), { recursive: true });
    const externalDirectory = path.join(sandbox, "external");
    mkdirSync(externalDirectory);
    symlinkSync(externalDirectory, path.join(stagingRoot, "update-external"), "dir");
    let stderr = "";

    await runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
        onStderr(text) {
          stderr += text;
        },
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset(url) {
            if (url.endsWith(candidate.archiveName)) {
              return candidate.archive;
            }
            if (url.endsWith(candidate.checksumsName)) {
              return candidate.checksums;
            }
            throw new Error(`Unexpected Release asset URL: ${url}`);
          },
          async listReleases(page) {
            return page === 1 ? [candidate.metadata] : [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: predecessor
      })
    );

    const activeRoot = path.join(monkeHome, "installs", "release-1.2.4-linux-x64");
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.4-linux-x64")
    );
    expect(
      JSON.parse(readFileSync(path.join(activeRoot, "install-manifest.json"), "utf-8"))
    ).toStrictEqual(candidate.manifest);
    expect(existsSync(predecessor)).toBeTruthy();
    expect(existsSync(olderInstall)).toBeFalsy();
    expect(readdirSync(path.join(monkeHome, "install-staging")).toSorted()).toStrictEqual([
      "manual-not-managed",
      "update-external"
    ]);
    expect(stderr).toContain("Updated monke-tools to 1.2.4");
  });

  test("a Customized release install reports every changed guidance path before lookup or staging", async () => {
    const sandbox = makeTempDir("release-update-customized");
    const monkeHome = path.join(sandbox, "monke-home");
    const installRoot = prepareActiveRelease(monkeHome, "1.2.3");
    write(installRoot, "skills/internal/example/SKILL.md", "modified\n");
    write(installRoot, "skills/internal/added.md", "added\n");
    rmSync(path.join(installRoot, "skills/references/internal/example.md"));
    let catalogCalled = false;

    const update = runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("Customized release install must not download assets");
          },
          async listReleases() {
            catalogCalled = true;
            return [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: installRoot
      })
    );

    await expect(update).rejects.toThrow(
      /Customized release install[\s\S]*skills\/internal\/added\.md[\s\S]*skills\/internal\/example\/SKILL\.md[\s\S]*skills\/references\/internal\/example\.md/u
    );
    expect(catalogCalled).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "install-staging"))).toBeFalsy();
  });

  test("a Release update replaces a dirty Local tool install without touching its source checkout", async () => {
    const sandbox = makeTempDir("local-to-release-update");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source checkout");
    write(sourceCheckout, "unfinished.txt", "maintainer work\n");
    prepareActiveRelease(monkeHome, "1.2.4", false);
    const localInstall = prepareActiveLocal(monkeHome, sourceCheckout);
    const candidate = prepareReleaseAsset(sandbox, "1.2.4");
    let stderr = "";

    await runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
        onMultiSelect() {
          throw new Error("update must not prompt");
        },
        onStderr(text) {
          stderr += text;
        },
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset(url) {
            return url.endsWith(candidate.archiveName) ? candidate.archive : candidate.checksums;
          },
          async listReleases(page) {
            return page === 1 ? [candidate.metadata] : [];
          }
        },
        toolBuildIdentity: "local+0123456-dirty",
        toolInstallRoot: localInstall
      })
    );

    expect(readFileSync(path.join(sourceCheckout, "unfinished.txt"), "utf-8")).toBe(
      "maintainer work\n"
    );
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.4-linux-x64")
    );
    expect(stderr).toContain("Release install in place of the Local tool install");
    expect(stderr).toContain(sourceCheckout);
    expect(stderr).toContain("vp run install:local");
  });

  test("a post-activation failure still reports the completed Local-to-Release transition", async () => {
    const sandbox = makeTempDir("local-to-release-partial-update");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    write(sourceCheckout, "unfinished.txt", "maintainer work\n");
    const localInstall = prepareActiveLocal(monkeHome, sourceCheckout);
    const candidate = prepareReleaseAsset(sandbox, "1.2.4");
    saveGlobalMonkeConfig(monkeHome, {
      skillInstallPreference: { targets: [{ kind: "codex" }] },
      version: 1
    });
    mkdirSync(path.join(home, ".codex", "skills", "monke-tools", "internal"), {
      recursive: true
    });
    let stderr = "";

    const update = runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
        onStderr(text) {
          stderr += text;
        },
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset(url) {
            return url.endsWith(candidate.archiveName) ? candidate.archive : candidate.checksums;
          },
          async listReleases(page) {
            return page === 1 ? [candidate.metadata] : [];
          }
        },
        toolBuildIdentity: "local+0123456-dirty",
        toolInstallRoot: localInstall
      })
    );

    await expect(update).rejects.toThrow(/Release install is active[\s\S]*mt skills configure/u);
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.4-linux-x64")
    );
    expect(stderr).toContain("Release install in place of the Local tool install");
    expect(stderr).toContain(sourceCheckout);
    expect(stderr).toContain("vp run install:local");
  });

  test("a bare Release update on the matching clean Release install performs no replacement", async () => {
    const sandbox = makeTempDir("release-update-current");
    const monkeHome = path.join(sandbox, "monke-home");
    const installRoot = prepareActiveRelease(monkeHome, "1.2.3");
    let stderr = "";

    await runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr(text) {
          stderr += text;
        },
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("the matching Release install must not be downloaded again");
          },
          async listReleases(page) {
            return page === 1 ? [release("1.2.3")] : [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: installRoot
      })
    );

    expect(stderr).toContain(
      "Active tool install 1.2.3 already matches the selected stable Release"
    );
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
    expect(existsSync(path.join(monkeHome, "install-staging"))).toBeFalsy();
  });

  test("a failed download preserves installs while cleaning recognized stale staging", async () => {
    const sandbox = makeTempDir("release-update-download-failure");
    const monkeHome = path.join(sandbox, "monke-home");
    const predecessor = prepareActiveRelease(monkeHome, "1.2.3");
    const olderInstall = prepareActiveRelease(monkeHome, "1.2.2", false);
    const stagingRoot = path.join(monkeHome, "install-staging");
    mkdirSync(path.join(stagingRoot, "update-interrupted"), { recursive: true });

    const update = runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("injected download failure");
          },
          async listReleases(page) {
            return page === 1 ? [release("1.2.4")] : [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: predecessor
      })
    );

    await expect(update).rejects.toThrow("injected download failure");
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
    expect(existsSync(predecessor)).toBeTruthy();
    expect(existsSync(olderInstall)).toBeTruthy();
    expect(readdirSync(stagingRoot)).toStrictEqual([]);
  });

  test("concurrent updates serialize and the follower rechecks the Active tool install", async () => {
    const sandbox = makeTempDir("release-update-concurrent");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const predecessor = prepareActiveRelease(monkeHome, "1.2.3");
    const candidate = prepareReleaseAsset(sandbox, "1.2.4");
    let catalogCalls = 0;
    let downloads = 0;
    let releaseFirstCatalog!: () => void;
    let markFirstCatalogStarted!: () => void;
    const firstCatalogStarted = new Promise<void>((resolve) => {
      markFirstCatalogStarted = resolve;
    });
    const firstCatalogGate = new Promise<void>((resolve) => {
      releaseFirstCatalog = resolve;
    });
    const distribution = {
      async downloadReleaseAsset(url: string) {
        downloads += 1;
        return url.endsWith(candidate.archiveName) ? candidate.archive : candidate.checksums;
      },
      async listReleases(page: number) {
        if (page !== 1) {
          return [];
        }
        catalogCalls += 1;
        if (catalogCalls === 1) {
          markFirstCatalogStarted();
          await firstCatalogGate;
        }
        return [candidate.metadata];
      }
    };
    const runtime = () =>
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
        onStderr() {},
        onStdout() {},
        platform: "linux",
        releaseDistribution: distribution,
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: predecessor
      });

    const leader = runCliAsync(["update"], runtime());
    await firstCatalogStarted;
    const follower = runCliAsync(["update"], runtime());
    releaseFirstCatalog();
    await Promise.all([leader, follower]);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.4-linux-x64")
    );
    expect(catalogCalls).toBe(2);
    expect(downloads).toBe(2);
  });

  test("an unsupported platform fails before catalog access or installation mutation", async () => {
    const sandbox = makeTempDir("release-update-unsupported");
    const monkeHome = path.join(sandbox, "monke-home");
    const installRoot = prepareActiveRelease(monkeHome, "1.2.3");
    let catalogCalled = false;

    const check = runCliAsync(
      ["update", "--check"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {},
        platform: "darwin",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("unsupported platforms must not download assets");
          },
          async listReleases() {
            catalogCalled = true;
            return [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: installRoot
      })
    );

    await expect(check).rejects.toThrow(/macOS arm64, Linux x64/u);
    expect(catalogCalled).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "install-staging"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "locks"))).toBeFalsy();
  });

  test.each([
    ["catalog lookup", /injected catalog failure/u],
    ["GitHub digest", /digest does not match GitHub metadata/u],
    ["published checksum", /checksum mismatch/u],
    ["archive structure", /tar .* failed/u],
    ["manifest provenance", /source commit does not match/u]
  ])("a %s failure preserves the complete previous installation", async (failure, expected) => {
    const sandbox = makeTempDir("release-update-failure");
    const monkeHome = path.join(sandbox, "monke-home");
    const predecessor = prepareActiveRelease(monkeHome, "1.2.3");
    const olderInstall = prepareActiveRelease(monkeHome, "1.2.2", false);
    const candidate = prepareReleaseAsset(
      sandbox,
      "1.2.4",
      failure === "manifest provenance" ? { manifestSourceCommit: "f".repeat(40) } : {}
    );
    const [archiveAsset, checksumsAsset] = candidate.metadata.assets;
    if (!archiveAsset || !checksumsAsset) {
      throw new Error("Release test fixture assets are missing");
    }
    if (failure === "GitHub digest") {
      archiveAsset.digest = `sha256:${"0".repeat(64)}`;
    }
    if (failure === "published checksum") {
      candidate.checksums = new TextEncoder().encode(
        `${"0".repeat(64)}  ${candidate.archiveName}\n`
      );
      checksumsAsset.digest = `sha256:${sha256Bytes(candidate.checksums)}`;
    }
    if (failure === "archive structure") {
      candidate.archive = new TextEncoder().encode("not a Release archive\n");
      candidate.checksums = new TextEncoder().encode(
        `${sha256Bytes(candidate.archive)}  ${candidate.archiveName}\n`
      );
      archiveAsset.digest = `sha256:${sha256Bytes(candidate.archive)}`;
      checksumsAsset.digest = `sha256:${sha256Bytes(candidate.checksums)}`;
    }

    const update = runCliAsync(
      ["update"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset(url) {
            return url.endsWith(candidate.archiveName) ? candidate.archive : candidate.checksums;
          },
          async listReleases(page) {
            if (failure === "catalog lookup") {
              throw new Error("injected catalog failure");
            }
            return page === 1 ? [candidate.metadata] : [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: predecessor
      })
    );

    await expect(update).rejects.toThrow(expected);
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
    expect(existsSync(predecessor)).toBeTruthy();
    expect(existsSync(olderInstall)).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "installs", "release-1.2.4-linux-x64"))).toBeFalsy();
    const stagingRoot = path.join(monkeHome, "install-staging");
    expect(existsSync(stagingRoot) ? readdirSync(stagingRoot) : []).toStrictEqual([]);
  });

  test.each([
    ["exact versions", ["update", "1.2.4"]],
    ["force replacement", ["update", "--force"]],
    ["quiet mode", ["update", "--quiet"]],
    ["channels", ["update", "--channel", "stable"]]
  ])("the v1 CLI rejects %s", async (_feature, arguments_) => {
    const sandbox = makeTempDir("release-update-cli-surface");
    let catalogCalled = false;
    const command = runCliAsync(
      arguments_,
      createRuntime({
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: path.join(sandbox, "monke-home") },
        onStderr() {},
        onStdout() {},
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("invalid update syntax must not download assets");
          },
          async listReleases() {
            catalogCalled = true;
            return [];
          }
        }
      })
    );

    await expect(command).rejects.toThrow(/too many arguments|unknown option/u);
    expect(catalogCalled).toBeFalsy();
  });

  test.each([
    [
      "missing checksums",
      (candidate: ReturnType<typeof release>) => {
        candidate.assets.pop();
      },
      /missing required asset/u
    ],
    [
      "invalid source provenance",
      (candidate: ReturnType<typeof release>) => {
        candidate.target_commitish = "main";
      },
      /full Git commit SHA/u
    ]
  ])("check rejects %s without downloading or staging", async (_failure, mutate, expected) => {
    const sandbox = makeTempDir("release-update-check-failure");
    const monkeHome = path.join(sandbox, "monke-home");
    const installRoot = prepareActiveRelease(monkeHome, "1.2.3");
    const candidate = release("1.2.4");
    mutate(candidate);

    const check = runCliAsync(
      ["update", "--check"],
      createRuntime({
        architecture: "x64",
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {},
        platform: "linux",
        releaseDistribution: {
          async downloadReleaseAsset() {
            throw new Error("check must not download malformed Release assets");
          },
          async listReleases(page) {
            return page === 1 ? [candidate] : [];
          }
        },
        toolBuildIdentity: "1.2.3",
        toolInstallRoot: installRoot
      })
    );

    await expect(check).rejects.toThrow(expected);
    expect(existsSync(path.join(monkeHome, "install-staging"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "locks"))).toBeFalsy();
  });
});
