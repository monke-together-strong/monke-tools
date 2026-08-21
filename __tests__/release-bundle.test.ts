import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  buildReleaseBundle,
  deriveNextReleaseVersion,
  hasReleaseOwnedChanges,
  isReleaseOwnedPath,
  releaseArchiveName,
  verifyReleaseArchive,
  verifyReleaseAssets,
  writeReleaseChecksums
} from "../src/release-bundle.ts";
import { makeTempDir } from "./helpers.ts";

const RELEASE_VERSION = "1.2.3";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
interface ManifestOverrides {
  guidanceHashes?: Record<string, string>;
  platform?: "linux-x64" | "macos-arm64";
  schemaVersion?: number;
  toolBuildIdentity?: string;
}
interface ReleaseFixtureOptions {
  executableVersion?: string;
  extraPath?: string;
  manifest?: ManifestOverrides;
  missingPath?: string;
  platform?: "linux-x64" | "macos-arm64";
  sandbox?: string;
}

function sha256(contents: Buffer | string) {
  return createHash("sha256").update(contents).digest("hex");
}

function makeReleaseArchive(options: ReleaseFixtureOptions = {}) {
  const sandbox = options.sandbox ?? makeTempDir("release-bundle");
  const platform = options.platform ?? "macos-arm64";
  const bundleRoot = path.join(sandbox, `bundle-${platform}`);
  const archiveName = `monke-tools-v${RELEASE_VERSION}-${platform}.tar.gz`;
  const archivePath = path.join(sandbox, archiveName);
  const skillContents = "# Example skill\n";
  const referenceContents = "# Example reference\n";

  mkdirSync(path.join(bundleRoot, "instructions"), { recursive: true });
  mkdirSync(path.join(bundleRoot, "skills", "codex"), { recursive: true });
  mkdirSync(path.join(bundleRoot, "skills", "internal", "example"), { recursive: true });
  mkdirSync(path.join(bundleRoot, "skills", "imported"), { recursive: true });
  mkdirSync(path.join(bundleRoot, "skills", "references", "internal"), { recursive: true });
  writeFileSync(
    path.join(bundleRoot, "skills", "internal", "example", "SKILL.md"),
    skillContents,
    "utf-8"
  );
  writeFileSync(
    path.join(bundleRoot, "skills", "references", "internal", "example.md"),
    referenceContents,
    "utf-8"
  );
  writeFileSync(path.join(bundleRoot, "instructions", "GLOBAL.md"), "# Global\n", "utf-8");
  writeFileSync(
    path.join(bundleRoot, "mt"),
    `#!/bin/sh\nprintf '%s\\n' '${options.executableVersion ?? RELEASE_VERSION}'\n`
  );
  writeFileSync(path.join(bundleRoot, "install.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bundleRoot, "mt"), 0o755);
  chmodSync(path.join(bundleRoot, "install.sh"), 0o755);
  writeFileSync(
    path.join(bundleRoot, "install-manifest.json"),
    `${JSON.stringify(
      {
        artifactName: archiveName,
        guidanceHashes: {
          "skills/internal/example/SKILL.md": sha256(skillContents),
          "skills/references/internal/example.md": sha256(referenceContents)
        },
        installKind: "release",
        minimumCodiffVersion: "1.9.0",
        platform,
        releaseTag: `monke-tools-v${RELEASE_VERSION}`,
        releaseVersion: RELEASE_VERSION,
        schemaVersion: 1,
        sourceCommit: SOURCE_COMMIT,
        toolBuildIdentity: RELEASE_VERSION,
        ...options.manifest
      },
      null,
      2
    )}\n`,
    "utf-8"
  );
  if (options.extraPath) {
    const extraPath = path.join(bundleRoot, options.extraPath);
    mkdirSync(path.dirname(extraPath), { recursive: true });
    writeFileSync(extraPath, "unexpected\n", "utf-8");
  }
  if (options.missingPath) {
    rmSync(path.join(bundleRoot, options.missingPath), { force: true, recursive: true });
  }

  const tar = spawnSync("tar", ["-czf", archivePath, "-C", bundleRoot, "."], {
    encoding: "utf-8"
  });
  if (tar.status !== 0) {
    throw new Error(`Could not create Release fixture: ${tar.stderr}`);
  }
  const checksumPath = path.join(sandbox, `monke-tools-v${RELEASE_VERSION}-checksums.txt`);
  writeFileSync(checksumPath, `${sha256(readFileSync(archivePath))}  ${archiveName}\n`, "utf-8");
  return { archivePath, bundleRoot, checksumPath };
}

describe("Release bundle verifier", () => {
  test("accepts a complete version-aligned Release bundle", () => {
    const fixture = makeReleaseArchive();

    const manifest = verifyReleaseArchive({
      archivePath: fixture.archivePath,
      checksumPath: fixture.checksumPath,
      expectedGuidanceRoot: fixture.bundleRoot,
      expectedPlatform: "macos-arm64",
      expectedSourceCommit: SOURCE_COMMIT,
      expectedVersion: RELEASE_VERSION
    });

    expect(manifest.artifactName).toBe(path.basename(fixture.archivePath));
    expect(manifest.guidanceHashes).toHaveProperty("skills/internal/example/SKILL.md");
  });

  const invalidBundles = [
    {
      expected: /entry is missing: instructions\/GLOBAL\.md/u,
      fixture: { missingPath: "instructions/GLOBAL.md" },
      name: "missing required content"
    },
    {
      expected: /platform does not match macos-arm64/u,
      fixture: { manifest: { platform: "linux-x64" } },
      name: "unexpected platform identity"
    },
    {
      expected: /Tool build identity does not match 1\.2\.3/u,
      fixture: { manifest: { toolBuildIdentity: "9.9.9" } },
      name: "mismatched manifest build identity"
    },
    {
      expected: /executable Tool build identity does not match 1\.2\.3/u,
      fixture: { executableVersion: "9.9.9" },
      name: "mismatched executable build identity"
    },
    {
      expected: /guidance hashes do not match/u,
      fixture: { manifest: { guidanceHashes: {} } },
      name: "changed Distributed guidance"
    },
    {
      expected: /schemaVersion/u,
      fixture: { manifest: { schemaVersion: 2 } },
      name: "a malformed manifest"
    },
    {
      expected: /unexpected Release archive entry/u,
      fixture: { extraPath: "skills/unexpected/file.md" },
      name: "unexpected bundle content"
    }
  ] satisfies { expected: RegExp; fixture: ReleaseFixtureOptions; name: string }[];

  test.each(invalidBundles)("rejects $name", ({ expected, fixture }) => {
    const release = makeReleaseArchive(fixture);

    expect(() =>
      verifyReleaseArchive({
        archivePath: release.archivePath,
        checksumPath: release.checksumPath,
        expectedGuidanceRoot: release.bundleRoot,
        expectedPlatform: "macos-arm64",
        expectedSourceCommit: SOURCE_COMMIT,
        expectedVersion: RELEASE_VERSION
      })
    ).toThrow(expected);
  });

  test("rejects an archive whose published checksum changed", () => {
    const fixture = makeReleaseArchive();
    writeFileSync(fixture.archivePath, "changed", "utf-8");

    expect(() =>
      verifyReleaseArchive({
        archivePath: fixture.archivePath,
        checksumPath: fixture.checksumPath,
        expectedGuidanceRoot: fixture.bundleRoot,
        expectedPlatform: "macos-arm64",
        expectedSourceCommit: SOURCE_COMMIT,
        expectedVersion: RELEASE_VERSION
      })
    ).toThrow(/checksum mismatch/u);
  });

  test("rejects an internally consistent archive that omits source guidance", () => {
    const fixture = makeReleaseArchive();
    writeFileSync(
      path.join(fixture.bundleRoot, "skills", "internal", "omitted.md"),
      "omitted from archive\n",
      "utf-8"
    );

    expect(() =>
      verifyReleaseArchive({
        archivePath: fixture.archivePath,
        checksumPath: fixture.checksumPath,
        expectedGuidanceRoot: fixture.bundleRoot,
        expectedPlatform: "macos-arm64",
        expectedSourceCommit: SOURCE_COMMIT,
        expectedVersion: RELEASE_VERSION
      })
    ).toThrow(/guidance hashes do not match/u);
  });

  test("requires checksums for both supported platform archives", () => {
    const directory = makeTempDir("release-assets");
    const source = makeReleaseArchive({ platform: "macos-arm64", sandbox: directory });
    makeReleaseArchive({ platform: "linux-x64", sandbox: directory });
    const checksumPath = writeReleaseChecksums(directory, RELEASE_VERSION);

    const manifests = verifyReleaseAssets({
      directory,
      expectedGuidanceRoot: source.bundleRoot,
      sourceCommit: SOURCE_COMMIT,
      version: RELEASE_VERSION
    });

    expect(manifests.map((manifest) => manifest.platform)).toStrictEqual([
      "macos-arm64",
      "linux-x64"
    ]);
    expect(readFileSync(checksumPath, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  test("builds an official bundle whose executable reports the selected version", () => {
    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
    const outputDirectory = makeTempDir("release-build");
    const archivePath = buildReleaseBundle({
      outputDirectory,
      platform,
      sourceCommit: SOURCE_COMMIT,
      version: RELEASE_VERSION
    });

    const manifest = verifyReleaseArchive({
      archivePath,
      expectedGuidanceRoot: path.join(import.meta.dirname, ".."),
      expectedPlatform: platform,
      expectedSourceCommit: SOURCE_COMMIT,
      expectedVersion: RELEASE_VERSION
    });

    expect(manifest.toolBuildIdentity).toBe(RELEASE_VERSION);
  });
});

describe("Mainline Release selection", () => {
  test("increments the highest stable monke-tools patch tag", () => {
    expect(
      deriveNextReleaseVersion([
        "monke-tools-v1.9.9",
        "monke-tools-v1.10.2",
        "monke-tools-v2.0.0",
        "monke-tools-v09.0.0",
        "monke-tools-v99.0.0-rc.1",
        "monke-tools-vbanana",
        "other-package-v99.0.0"
      ])
    ).toBe("2.0.1");
  });

  test("rejects leading-zero versions", () => {
    expect(() => releaseArchiveName("01.2.3", "macos-arm64")).toThrow(
      /stable major\.minor\.patch semantic version/u
    );
  });

  test.each([
    ["src/index.ts", true],
    ["skills/codex/codex-chrome-use/SKILL.md", true],
    ["skills/internal/implement/SKILL.md", true],
    ["scripts/install-release.sh", true],
    ["bun.lock", false],
    ["README.md", false],
    ["docs/adr/0009-distribute-monke-tools-as-atomic-release-bundles.md", false],
    ["packages/oxc-config/src/oxlint.ts", false]
  ])("classifies %s as release-owned: %s", (filePath, expected) => {
    expect(isReleaseOwnedPath(filePath)).toBe(expected);
  });

  test("skips an unrelated workspace dependency and lockfile change", () => {
    expect(hasReleaseOwnedChanges(["bun.lock", "packages/oxc-config/package.json"])).toBeFalsy();
    expect(hasReleaseOwnedChanges(["bun.lock", "package.json"])).toBeTruthy();
    expect(hasReleaseOwnedChanges(["bun.lock"])).toBeTruthy();
  });
});
