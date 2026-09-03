import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  buildReleaseBundle,
  deriveNextReleaseVersion,
  hasReleaseOwnedChanges,
  isReleaseOwnedPath,
  verifyReleaseAssets,
  writeReleaseChecksums,
  writeStableReleaseCatalog
} from "../src/release-bundle.ts";
import {
  releaseArchiveName,
  releaseChecksumsName,
  verifyReleaseArchive
} from "../src/release-contract.ts";
import { makeTempDir } from "./helpers.ts";

const RELEASE_BUNDLE_BUILD_TIMEOUT_MS = 120_000;

const RELEASE_VERSION = "1.2.3";
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
interface ManifestOverrides {
  artifactDigest?: string;
  createdAt?: string;
  guidanceHashes?: Record<string, string>;
  minimumCodiffVersion?: string;
  platform?: "linux-x64" | "macos-arm64";
  schemaVersion?: number;
  toolBuildIdentity?: string;
}
interface ReleaseFixtureOptions {
  executableContents?: string;
  executableVersion?: string;
  extraPath?: string;
  manifest?: ManifestOverrides;
  missingPath?: string;
  platform?: "linux-x64" | "macos-arm64";
  sandbox?: string;
  tamperGlobalInstructions?: boolean;
}

function makeReleaseArchive(options: ReleaseFixtureOptions = {}) {
  const sandbox = options.sandbox ?? makeTempDir("release-bundle");
  const platform = options.platform ?? "macos-arm64";
  const bundleRoot = path.join(sandbox, `bundle-${platform}`);
  const archiveName = `monke-tools-v${RELEASE_VERSION}-${platform}.tar.gz`;
  const archivePath = path.join(sandbox, archiveName);
  const skillContents = "# Example skill\n";
  const referenceContents = "# Example reference\n";
  const executableContents =
    options.executableContents ??
    `#!/bin/sh\nprintf '%s\\n' '${options.executableVersion ?? RELEASE_VERSION}'\n`;

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
  writeFileSync(path.join(bundleRoot, "mt"), executableContents);
  writeFileSync(path.join(bundleRoot, "install.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bundleRoot, "mt"), 0o755);
  chmodSync(path.join(bundleRoot, "install.sh"), 0o755);
  writeFileSync(
    path.join(bundleRoot, "install-manifest.json"),
    `${JSON.stringify(
      {
        artifactDigest: hash("sha256", executableContents, "hex"),
        artifactName: archiveName,
        createdAt: "2026-08-21T12:34:56.000Z",
        guidanceHashes: {
          "instructions/GLOBAL.md": hash("sha256", "# Global\n", "hex"),
          "skills/internal/example/SKILL.md": hash("sha256", skillContents, "hex"),
          "skills/references/internal/example.md": hash("sha256", referenceContents, "hex")
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
  if (options.tamperGlobalInstructions) {
    writeFileSync(path.join(bundleRoot, "instructions", "GLOBAL.md"), "# Stale Global\n", "utf-8");
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
  writeFileSync(
    checksumPath,
    `${hash("sha256", readFileSync(archivePath), "hex")}  ${archiveName}\n`,
    "utf-8"
  );
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
    expect(manifest.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.createdAt).toBe("2026-08-21T12:34:56.000Z");
    expect(manifest.guidanceHashes).toHaveProperty("skills/internal/example/SKILL.md");
  });

  const invalidBundles = [
    {
      expected: /artifact digest does not match/u,
      fixture: { manifest: { artifactDigest: "0".repeat(64) } },
      name: "mismatched executable digest"
    },
    {
      expected: /createdAt/u,
      fixture: { manifest: { createdAt: "not-a-time" } },
      name: "invalid creation time"
    },
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
      expected: /executable Tool build identity does not match 1\.2\.3.*ENOENT/u,
      fixture: { executableContents: "#!/definitely-missing-monke-interpreter\n" },
      name: "an executable that cannot be started"
    },
    {
      expected: /guidance hashes do not match/u,
      fixture: { manifest: { guidanceHashes: {} } },
      name: "changed Distributed guidance"
    },
    {
      expected: /guidance hashes do not match/u,
      fixture: { tamperGlobalInstructions: true },
      name: "changed Global instructions"
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

  test("requires one Codiff policy across platform archives", () => {
    const directory = makeTempDir("release-assets-codiff-policy");
    const source = makeReleaseArchive({ platform: "macos-arm64", sandbox: directory });
    makeReleaseArchive({
      manifest: { minimumCodiffVersion: "2.0.0" },
      platform: "linux-x64",
      sandbox: directory
    });
    writeReleaseChecksums(directory, RELEASE_VERSION);

    expect(() =>
      verifyReleaseAssets({
        directory,
        expectedGuidanceRoot: source.bundleRoot,
        sourceCommit: SOURCE_COMMIT,
        version: RELEASE_VERSION
      })
    ).toThrow(/Codiff minimum does not match 1\.9\.0/u);
  });

  test("writes the verified stable Release catalog contract", () => {
    const directory = makeTempDir("release-catalog");
    makeReleaseArchive({ platform: "macos-arm64", sandbox: directory });
    makeReleaseArchive({ platform: "linux-x64", sandbox: directory });
    writeReleaseChecksums(directory, RELEASE_VERSION);
    const outputPath = path.join(directory, "catalog", "stable.tsv");

    writeStableReleaseCatalog({
      directory,
      outputPath,
      sourceCommit: SOURCE_COMMIT,
      version: RELEASE_VERSION
    });

    const fields = readFileSync(outputPath, "utf-8").trim().split("\t");
    expect(fields.slice(0, 4)).toStrictEqual([
      "1",
      RELEASE_VERSION,
      `monke-tools-v${RELEASE_VERSION}`,
      SOURCE_COMMIT
    ]);
    expect(fields.slice(4)).toStrictEqual(
      [
        releaseArchiveName(RELEASE_VERSION, "macos-arm64"),
        releaseArchiveName(RELEASE_VERSION, "linux-x64"),
        releaseChecksumsName(RELEASE_VERSION)
      ].map(
        (assetName) =>
          `sha256:${hash("sha256", readFileSync(path.join(directory, assetName)), "hex")}`
      )
    );
  });

  test(
    "builds an official bundle whose executable reports the selected version",
    () => {
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
      expect(manifest.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(Date.parse(manifest.createdAt)).not.toBeNaN();
      // This test compiles the CLI into a native executable. The default 5s budget leaves almost
      // no headroom over the local compile time, so a slower CI runner times out.
    },
    RELEASE_BUNDLE_BUILD_TIMEOUT_MS
  );
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
    ["install.sh", true],
    ["scripts/install-release.sh", true],
    [".github/actions/setup-mainline/action.yml", true],
    [".github/workflows/publish.yml", true],
    [".github/workflows/publish-packages.yml", false],
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
