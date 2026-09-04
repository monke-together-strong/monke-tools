import { hash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";

import { write, writeExecutable } from "./helpers.ts";

export const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

export function prepareActiveRelease(monkeHome: string, version: string, activate = true) {
  const installRoot = path.join(monkeHome, "installs", `release-${version}-linux-x64`);
  const guidance = {
    "instructions/GLOBAL.md": "Release baseline.\n",
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
      artifactDigest: "0".repeat(64),
      artifactName: `monke-tools-v${version}-linux-x64.tar.gz`,
      createdAt: "2026-08-21T12:34:56.000Z",
      guidanceHashes: Object.fromEntries(
        Object.entries(guidance).map(([filePath, contents]) => [
          filePath,
          hash("sha256", contents, "hex")
        ])
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

export function prepareActiveLocal(
  monkeHome: string,
  sourceCheckout: string,
  options: { sourceCommit?: string; sourceDirty?: boolean } = {}
) {
  const sourceCommit = options.sourceCommit ?? SOURCE_COMMIT;
  const sourceDirty = options.sourceDirty ?? true;
  const installId = localInstallId(sourceDirty, sourceCommit);
  const toolBuildIdentity = `local+${sourceCommit.slice(0, 7)}${sourceDirty ? "-dirty" : ""}`;
  const installRoot = path.join(monkeHome, "installs", installId);
  writeExecutable(path.join(installRoot, "mt"), "#!/bin/sh\nexit 0\n");
  write(
    installRoot,
    "install-manifest.json",
    `${JSON.stringify({
      createdAt: "2026-08-21T12:34:56.000Z",
      createdBy: "bun run install:local",
      installId,
      installKind: "local",
      minimumCodiffVersion: "1.9.0",
      platform: "linux-x64",
      schemaVersion: 1,
      sourceCheckout,
      sourceCommit,
      sourceDirty,
      toolBuildIdentity
    })}\n`
  );
  mkdirSync(monkeHome, { recursive: true });
  symlinkSync(path.relative(monkeHome, installRoot), path.join(monkeHome, "current"), "dir");
  return installRoot;
}

function localInstallId(sourceDirty: boolean, sourceCommit: string) {
  if (sourceDirty) {
    return "local-dirty";
  }
  return sourceCommit === SOURCE_COMMIT ? "local-clean-same" : "local-clean-different";
}

export function release(version: string, options: { draft?: boolean; prerelease?: boolean } = {}) {
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

export function prepareReleaseAsset(
  sandbox: string,
  version: string,
  options: {
    manifestPlatform?: "linux-x64" | "macos-arm64";
    manifestSourceCommit?: string;
    minimumCodiffVersion?: string;
  } = {}
) {
  const tag = `monke-tools-v${version}`;
  const archiveName = `${tag}-linux-x64.tar.gz`;
  const checksumsName = `${tag}-checksums.txt`;
  const bundleRoot = path.join(sandbox, `bundle-${version}`);
  const guidance = {
    "instructions/GLOBAL.md": `Release ${version} baseline.\n`,
    "skills/codex/.keep": "\n",
    "skills/imported/.keep": "\n",
    "skills/internal/example/SKILL.md": `---\nname: example-${version}\n---\n`,
    "skills/references/internal/example.md": `Release ${version} reference.\n`
  };
  for (const [filePath, contents] of Object.entries(guidance)) {
    write(bundleRoot, filePath, contents);
  }
  writeExecutable(path.join(bundleRoot, "install.sh"), "#!/bin/sh\nexit 0\n");
  const executableContents = `#!/bin/sh\nprintf '%s\\n' '${version}'\n`;
  writeExecutable(path.join(bundleRoot, "mt"), executableContents);
  const manifest = {
    artifactDigest: hash("sha256", executableContents, "hex"),
    artifactName: archiveName,
    createdAt: "2026-08-21T12:34:56.000Z",
    guidanceHashes: Object.fromEntries(
      Object.entries(guidance).map(([filePath, contents]) => [
        filePath,
        hash("sha256", contents, "hex")
      ])
    ),
    installKind: "release",
    minimumCodiffVersion: options.minimumCodiffVersion ?? "1.9.0",
    platform: options.manifestPlatform ?? "linux-x64",
    releaseTag: tag,
    releaseVersion: version,
    schemaVersion: 1,
    sourceCommit: options.manifestSourceCommit ?? SOURCE_COMMIT,
    toolBuildIdentity: version
  };
  write(bundleRoot, "install-manifest.json", `${JSON.stringify(manifest)}\n`);
  const archivePath = path.join(sandbox, archiveName);
  const tar = Bun.spawnSync({ cmd: ["tar", "-czf", archivePath, "-C", bundleRoot, "."] });
  if (tar.exitCode !== 0) {
    throw new Error(`Could not prepare Release archive fixture: ${tar.stderr.toString()}`);
  }
  const archive = new Uint8Array(readFileSync(archivePath));
  const checksums = new TextEncoder().encode(`${hash("sha256", archive, "hex")}  ${archiveName}\n`);
  const metadata = release(version);
  const [archiveAsset, checksumsAsset] = metadata.assets;
  if (!archiveAsset || !checksumsAsset) {
    throw new Error("Release test fixture assets are missing");
  }
  archiveAsset.digest = `sha256:${hash("sha256", archive, "hex")}`;
  checksumsAsset.digest = `sha256:${hash("sha256", checksums, "hex")}`;
  return { archive, archiveName, checksums, checksumsName, manifest, metadata };
}
