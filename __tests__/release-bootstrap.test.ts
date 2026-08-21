import { hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import type { input } from "zod";

import type { ReleaseCatalogEntrySchema } from "../src/release-catalog-schema.ts";
import { makeTempDir, write, writeExecutable } from "./helpers.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

type ReleaseResponse = input<typeof ReleaseCatalogEntrySchema>;

const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function prepareBootstrapFixture(
  options: {
    corruptChecksum?: boolean;
    failDownload?: boolean;
    failLookup?: boolean;
    invalidArchive?: boolean;
    machine?: string;
    missingAsset?: boolean;
    olderVersion?: string;
    selectedVersion?: string;
    sourceCommit?: string;
    system?: string;
  } = {}
) {
  const sandbox = makeTempDir("release-bootstrap");
  const bin = path.join(sandbox, "bin");
  const responses = path.join(sandbox, "responses");
  const bundleRoot = path.join(sandbox, "bundle");
  const platform = options.system === "Darwin" ? "macos-arm64" : "linux-x64";
  const selectedVersion = options.selectedVersion ?? "1.2.3";
  const olderVersion = options.olderVersion ?? "1.2.2";
  const selectedTag = `monke-tools-v${selectedVersion}`;
  const archiveName = `${selectedTag}-${platform}.tar.gz`;
  const checksumName = `${selectedTag}-checksums.txt`;
  const archivePath = path.join(responses, archiveName);
  const checksumPath = path.join(responses, checksumName);
  const installLog = path.join(sandbox, "install.log");
  const bundlePathLog = path.join(sandbox, "bundle-path.log");
  const bootstrapOwnerLog = path.join(sandbox, "bootstrap-owner.log");
  const releaseIdentityLog = path.join(sandbox, "release-identity.log");
  const curlLog = path.join(sandbox, "curl.log");
  mkdirSync(responses, { recursive: true });
  writeExecutable(
    path.join(bundleRoot, "install.sh"),
    `#!/bin/sh
printf '%s\n' "$0" > "$MONKE_BOOTSTRAP_TEST_BUNDLE_PATH_LOG"
cat "$(dirname "$(dirname "$0")")/.monke-tools-bootstrap-pid" > "$MONKE_BOOTSTRAP_TEST_OWNER_LOG"
printf '%s\n' \
  "$MONKE_TOOLS_EXPECTED_RELEASE_VERSION" \
  "$MONKE_TOOLS_EXPECTED_RELEASE_TAG" \
  "$MONKE_TOOLS_EXPECTED_ARTIFACT_NAME" \
  "$MONKE_TOOLS_EXPECTED_SOURCE_COMMIT" > "$MONKE_BOOTSTRAP_TEST_IDENTITY_LOG"
printf '%s\n' "$@" > "$MONKE_BOOTSTRAP_TEST_INSTALL_LOG"
`
  );
  if (options.invalidArchive) {
    write(responses, archiveName, "not a tar archive\n");
  } else {
    const tar = Bun.spawnSync({ cmd: ["tar", "-czf", archivePath, "-C", bundleRoot, "."] });
    if (tar.exitCode !== 0) {
      throw new Error(`Could not create Release bootstrap fixture: ${tar.stderr.toString()}`);
    }
  }
  const archiveHash = hash("sha256", readFileSync(archivePath), "hex");
  write(
    responses,
    checksumName,
    `${options.corruptChecksum ? "0".repeat(64) : archiveHash}  ${archiveName}\n`
  );
  const releasePage = (...values: ReleaseResponse[]) => `${JSON.stringify(values)}\n`;
  const selectedRelease: ReleaseResponse = {
    assets: options.missingAsset
      ? [
          {
            browser_download_url: `https://github.com/monke-together-strong/monke-tools/releases/download/${selectedTag}/${checksumName}`,
            digest: `sha256:${hash("sha256", readFileSync(checksumPath), "hex")}`,
            name: checksumName
          }
        ]
      : [
          {
            browser_download_url: `https://github.com/monke-together-strong/monke-tools/releases/download/${selectedTag}/${archiveName}`,
            digest: `sha256:${archiveHash}`,
            name: archiveName
          },
          {
            browser_download_url: `https://github.com/monke-together-strong/monke-tools/releases/download/${selectedTag}/${checksumName}`,
            digest: `sha256:${hash("sha256", readFileSync(checksumPath), "hex")}`,
            name: checksumName
          }
        ],
    draft: false,
    prerelease: false,
    tag_name: selectedTag,
    target_commitish: options.sourceCommit ?? SOURCE_COMMIT
  };
  write(
    responses,
    "page-1.json",
    releasePage(
      {
        assets: [],
        body: 'Example text containing "draft": false and "tag_name": "monke-tools-v99.0.0".',
        draft: false,
        prerelease: false,
        tag_name: "@monke/other@9.0.0",
        target_commitish: SOURCE_COMMIT
      },
      {
        assets: [],
        draft: false,
        prerelease: false,
        tag_name: `monke-tools-v${olderVersion}`,
        target_commitish: SOURCE_COMMIT
      }
    )
  );
  write(
    responses,
    "page-2.json",
    releasePage(
      {
        assets: [],
        draft: false,
        prerelease: true,
        tag_name: "monke-tools-v1.3.0",
        target_commitish: SOURCE_COMMIT
      },
      selectedRelease,
      {
        assets: [],
        draft: true,
        prerelease: false,
        tag_name: "monke-tools-v9.0.0",
        target_commitish: SOURCE_COMMIT
      }
    )
  );
  write(responses, "page-3.json", "[]\n");
  write(responses, "selected-release.json", `${JSON.stringify(selectedRelease)}\n`);
  writeExecutable(
    path.join(bin, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf '%s\n' ${JSON.stringify(options.system ?? "Linux")} ;;
  -m) printf '%s\n' ${JSON.stringify(options.machine ?? "x86_64")} ;;
esac
`
  );
  writeExecutable(
    path.join(bin, "curl"),
    `#!/bin/sh
set -eu
output=
url=
read_config=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) output=$2; shift 2 ;;
    --config) [ "$2" = - ] && read_config=true; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$read_config" = false ] || cat >/dev/null
printf '%s\n' "$url" >> ${JSON.stringify(curlLog)}
${options.failLookup ? "case \"$url\" in *'page=1') exit 88 ;; esac" : ""}
${options.failDownload ? `case "$url" in *${archiveName}) exit 89 ;; esac` : ""}
case "$url" in
  */releases/tags/${selectedTag}) source=${JSON.stringify(path.join(responses, "selected-release.json"))} ;;
  *'page=1') source=${JSON.stringify(path.join(responses, "page-1.json"))} ;;
  *'page=2') source=${JSON.stringify(path.join(responses, "page-2.json"))} ;;
  *'page=3') source=${JSON.stringify(path.join(responses, "page-3.json"))} ;;
  *${archiveName}) source=${JSON.stringify(archivePath)} ;;
  *${checksumName}) source=${JSON.stringify(checksumPath)} ;;
  *) printf 'unexpected URL: %s\n' "$url" >&2; exit 91 ;;
esac
if [ -n "$output" ]; then cp "$source" "$output"; else cat "$source"; fi
`
  );
  return {
    archiveName,
    bin,
    bootstrapOwnerLog,
    bundlePathLog,
    curlLog,
    installLog,
    releaseIdentityLog,
    sandbox
  };
}

function runBootstrap(
  fixture: ReturnType<typeof prepareBootstrapFixture>,
  options: { args?: string[]; env?: Record<string, string> } = {}
) {
  return Bun.spawnSync({
    cmd: ["sh", path.join(repositoryRoot, "install.sh"), ...(options.args ?? [])],
    env: {
      HOME: path.join(fixture.sandbox, "home"),
      MONKE_BOOTSTRAP_TEST_BUNDLE_PATH_LOG: fixture.bundlePathLog,
      MONKE_BOOTSTRAP_TEST_IDENTITY_LOG: fixture.releaseIdentityLog,
      MONKE_BOOTSTRAP_TEST_INSTALL_LOG: fixture.installLog,
      MONKE_BOOTSTRAP_TEST_OWNER_LOG: fixture.bootstrapOwnerLog,
      MONKE_HOME: path.join(fixture.sandbox, "monke-home"),
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      SHELL: "/bin/sh",
      ...options.env
    },
    stderr: "pipe",
    stdout: "pipe"
  });
}

describe("public Release bootstrap", () => {
  test("selects and verifies the highest paginated stable Release", () => {
    const fixture = prepareBootstrapFixture();
    const secret = "github-token-must-not-be-logged";
    const result = runBootstrap(fixture, {
      args: ["--targets", "codex"],
      env: { GH_TOKEN: secret }
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.installLog, "utf-8").split("\n").filter(Boolean)).toStrictEqual([
      "--targets",
      "codex"
    ]);
    const curlLog = readFileSync(fixture.curlLog, "utf-8");
    expect(curlLog).toContain("page=3");
    expect(curlLog).toContain("monke-tools-v1.2.3-linux-x64.tar.gz");
    expect(curlLog).not.toContain(secret);
    expect(readFileSync(fixture.bootstrapOwnerLog, "utf-8")).toMatch(/^\d+\n$/u);
    expect(readFileSync(fixture.releaseIdentityLog, "utf-8").trim().split("\n")).toStrictEqual([
      "1.2.3",
      "monke-tools-v1.2.3",
      "monke-tools-v1.2.3-linux-x64.tar.gz",
      SOURCE_COMMIT
    ]);
    const monkeHome = path.join(fixture.sandbox, "monke-home");
    expect(
      readFileSync(fixture.bundlePathLog, "utf-8")
        .trim()
        .startsWith(path.join(monkeHome, "install-staging", "public-bootstrap-"))
    ).toBeTruthy();
    expect(readdirSync(path.join(monkeHome, "install-staging"))).toStrictEqual([]);
  });

  test("maps Apple Silicon Macs to the macOS Release asset", () => {
    const fixture = prepareBootstrapFixture({ machine: "arm64", system: "Darwin" });
    const result = runBootstrap(fixture);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.curlLog, "utf-8")).toContain(fixture.archiveName);
  });

  test("compares arbitrarily large stable SemVer components without numeric precision loss", () => {
    const selectedVersion = "9007199254740993.0.0";
    const fixture = prepareBootstrapFixture({
      olderVersion: "9007199254740992.0.0",
      selectedVersion
    });
    const result = runBootstrap(fixture);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.curlLog, "utf-8")).toContain(
      `monke-tools-v${selectedVersion}-linux-x64.tar.gz`
    );
  });

  test("uses GITHUB_TOKEN without exposing it in command logs", () => {
    const fixture = prepareBootstrapFixture();
    const secret = "fallback-github-token-must-not-be-logged";
    const result = runBootstrap(fixture, { env: { GITHUB_TOKEN: secret } });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(fixture.curlLog, "utf-8")).not.toContain(secret);
  });

  test("unsupported platforms fail before network access or installation changes", () => {
    const fixture = prepareBootstrapFixture({ machine: "x86_64", system: "Darwin" });
    const result = runBootstrap(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("macOS arm64, Linux x64");
    expect(existsSync(fixture.curlLog)).toBeFalsy();
    expect(existsSync(fixture.installLog)).toBeFalsy();
  });

  test("checksum failure prevents bundle-owned installer delegation", () => {
    const fixture = prepareBootstrapFixture({ corruptChecksum: true });
    const result = runBootstrap(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("checksum");
    expect(existsSync(fixture.installLog)).toBeFalsy();
  });

  test("invalid selected commit metadata prevents bundle-owned installer delegation", () => {
    const fixture = prepareBootstrapFixture({ sourceCommit: "main" });
    const result = runBootstrap(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("commit metadata is invalid");
    expect(existsSync(fixture.installLog)).toBeFalsy();
  });

  test.each([
    { expected: "GitHub Release lookup failed", options: { failLookup: true } },
    { expected: "archive download failed", options: { failDownload: true } },
    { expected: "missing platform asset", options: { missingAsset: true } },
    { expected: "archive extraction failed", options: { invalidArchive: true } }
  ])("$expected prevents installer delegation", ({ expected, options }) => {
    const fixture = prepareBootstrapFixture(options);
    const monkeHome = path.join(fixture.sandbox, "monke-home");
    const result = runBootstrap(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(expected);
    expect(existsSync(fixture.installLog)).toBeFalsy();
    expect(readdirSync(path.join(monkeHome, "install-staging"))).toStrictEqual([]);
  });
});
