#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "@commander-js/extra-typings";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { MINIMUM_CODIFF_VERSION_TEXT } from "../src/codiff.ts";
import { ReleasePlatformSchema } from "../src/install-manifest.ts";
import {
  buildReleaseBundle,
  deriveNextReleaseVersion,
  hasReleaseOwnedChangesBetween,
  listReleaseTags,
  verifyReleaseAssets,
  writeReleaseChecksums,
  writeStableReleaseCatalog
} from "../src/release-bundle.ts";
import { verifyReleaseArchive } from "../src/release-contract.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const program = new Command().name("release-bundle").allowExcessArguments(false);
configureCliParser(program);

program
  .command("build")
  .requiredOption("--output <directory>")
  .requiredOption("--platform <platform>")
  .requiredOption("--source-commit <sha>")
  .requiredOption("--version <version>")
  .action((options) => {
    const archivePath = buildReleaseBundle({
      outputDirectory: options.output,
      platform: ReleasePlatformSchema.parse(options.platform),
      sourceCommit: options.sourceCommit,
      version: options.version
    });
    process.stdout.write(`${archivePath}\n`);
  });

program
  .command("checksums")
  .requiredOption("--directory <directory>")
  .requiredOption("--version <version>")
  .action((options) => {
    process.stdout.write(`${writeReleaseChecksums(options.directory, options.version)}\n`);
  });

program
  .command("catalog")
  .requiredOption("--directory <directory>")
  .requiredOption("--output <path>")
  .requiredOption("--source-commit <sha>")
  .requiredOption("--version <version>")
  .action((options) => {
    process.stdout.write(
      `${writeStableReleaseCatalog({
        directory: options.directory,
        outputPath: options.output,
        sourceCommit: options.sourceCommit,
        version: options.version
      })}\n`
    );
  });

program.command("next-version").action(() => {
  process.stdout.write(`${deriveNextReleaseVersion(listReleaseTags())}\n`);
});

program
  .command("relevant")
  .requiredOption("--after <sha>")
  .requiredOption("--before <sha>")
  .action((options) => {
    process.stdout.write(
      `${String(hasReleaseOwnedChangesBetween(options.before, options.after))}\n`
    );
  });

program
  .command("verify")
  .requiredOption("--archive <path>")
  .option("--checksums <path>")
  .requiredOption("--platform <platform>")
  .requiredOption("--source-commit <sha>")
  .requiredOption("--version <version>")
  .action((options) => {
    verifyReleaseArchive({
      archivePath: options.archive,
      checksumPath: options.checksums,
      expectedGuidanceRoot: repositoryRoot,
      expectedMinimumCodiffVersion: MINIMUM_CODIFF_VERSION_TEXT,
      expectedPlatform: ReleasePlatformSchema.parse(options.platform),
      expectedSourceCommit: options.sourceCommit,
      expectedVersion: options.version
    });
  });

program
  .command("verify-assets")
  .requiredOption("--directory <directory>")
  .requiredOption("--source-commit <sha>")
  .requiredOption("--version <version>")
  .action((options) => {
    verifyReleaseAssets({
      directory: path.resolve(options.directory),
      expectedGuidanceRoot: repositoryRoot,
      sourceCommit: options.sourceCommit,
      version: options.version
    });
  });

try {
  program.parse(Bun.argv.slice(2), { from: "user" });
} catch (error) {
  reportCliFailure(error);
}
