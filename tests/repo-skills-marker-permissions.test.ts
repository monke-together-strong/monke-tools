import { chmodSync, lstatSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  makeTempDir,
  read,
  write,
  writeExecutable
} from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const uid = process.geteuid?.() ?? -1;
const setupRuntime = createTestRuntime();

// Ownership fixtures require an unprivileged caller and passwordless sudo for chown.
const canChangeFixtureOwner =
  process.platform !== "win32" &&
  uid > 0 &&
  Bun.which("sudo") !== null &&
  setupRuntime.exec("sudo", ["-n", "true"], { allowFailure: true }).exitCode === 0;

function changeOwner(file: string, owner: number) {
  setupRuntime.exec("sudo", ["-n", "chown", "-h", String(owner), file]);
}

describe.skipIf(!canChangeFixtureOwner)("sticky restore marker ownership", () => {
  it.each([
    { action: "add", denied: true, marker: "file", name: "foreign owners", owner: "foreign" },
    { action: "update", denied: true, marker: "file", name: "foreign owners", owner: "foreign" },
    { action: "add", denied: false, marker: "file", name: "directory owner", owner: "directory" },
    { action: "add", denied: false, marker: "symlink", name: "entry owner", owner: "entry" },
    { action: "add", denied: true, marker: "symlink", name: "target owner", owner: "foreign" },
    { action: "add", denied: false, marker: "absent", name: "absent marker", owner: "foreign" },
    { action: "restore", denied: false, marker: "file", name: "cached marker", owner: "foreign" }
  ])("respects sticky marker permissions on $action for $name", async (scenario) => {
    const sandbox = makeTempDir("sticky-marker");
    const repo = createRepo(path.join(sandbox, "consumer"), { "README.md": "Consumer.\n" });

    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "skills/first/SKILL.md": "---\nname: first\ndescription: First.\n---\nAccepted.\n"
    });

    const bin = path.join(sandbox, "bin");
    writeExecutable(
      path.join(bin, "npx"),
      '#!/bin/sh\nset -eu\nmkdir -p .agents/skills\ncp -R "$4/skills/first" .agents/skills/\n'
    );
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    const runtime = createTestRuntime({
      cwd: repo,
      env: {
        HOME: path.join(sandbox, "home"),
        MONKE_HOME: path.join(sandbox, "monke"),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`
      },
      onStderr() {},
      onStdout() {}
    });

    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const acceptedPin = git(upstream, ["rev-parse", "HEAD"]);
    const config = read(repo, "monke.yml");
    const guidance = read(repo, "skills/imported/first/SKILL.md");
    const marker = path.join(repo, "skills/.monke-restored.json");
    const markerBytes = read(repo, "skills/.monke-restored.json");
    const parent = path.dirname(marker);
    const target = path.join(sandbox, "marker-target");
    const entryOwner = scenario.owner === "entry" ? uid : 65_534;
    const parentOwner = scenario.owner === "directory" ? uid : 65_534;

    if (scenario.marker === "symlink") {
      renameSync(marker, target);
      symlinkSync(target, marker);
      changeOwner(target, scenario.owner === "entry" ? 65_534 : uid);
    }

    if (scenario.marker === "absent") {
      rmSync(marker);
    } else {
      changeOwner(marker, entryOwner);
    }

    try {
      chmodSync(parent, 0o1777);
      changeOwner(parent, parentOwner);
      expect(lstatSync(parent).uid).toBe(parentOwner);
      // oxlint-disable-next-line no-bitwise -- Verify the actual POSIX fixture permissions.
      expect(lstatSync(parent).mode & 0o7777).toBe(0o1777);
      expect(lstatSync(marker, { throwIfNoEntry: false })?.uid).toBe(
        scenario.marker === "absent" ? undefined : entryOwner
      );

      if (scenario.action === "restore") {
        writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 42\n");
      } else {
        write(
          upstream,
          "skills/first/SKILL.md",
          "---\nname: first\ndescription: First.\n---\nCandidate.\n"
        );
        git(upstream, ["add", "."]);
        git(upstream, ["commit", "-m", "Advance source"]);
      }

      const operation = runCliAsync(
        scenario.action === "add"
          ? ["skills", "add", upstream, "--repo", "--skill", "first"]
          : [
              "skills",
              scenario.action,
              "--repo",
              ...(scenario.action === "update" ? ["--adapter", "codiff"] : [])
            ],
        runtime
      );

      const failure = await operation.then(() => "", String);
      expect(Boolean(failure)).toBe(scenario.denied);
      expect(failure.includes(".monke-restored.json")).toBe(scenario.denied);
      const unchanged = scenario.denied || scenario.action === "restore";
      expect(read(repo, "monke.yml") === config).toBe(unchanged);
      expect(read(repo, "skills/imported/first/SKILL.md") === guidance).toBe(unchanged);
      expect(read(repo, "skills/.monke-restored.json") === markerBytes).toBe(unchanged);
      expect(read(repo, "monke.yml")).toContain(
        unchanged ? acceptedPin : git(upstream, ["rev-parse", "HEAD"])
      );
      expect(read(repo, "skills/imported/first/SKILL.md")).toContain(
        unchanged ? "Accepted." : "Candidate."
      );

      const targetBytes =
        scenario.marker === "symlink" ? read(sandbox, "marker-target") : undefined;

      expect(targetBytes).toBe(scenario.marker === "symlink" ? markerBytes : undefined);
    } finally {
      changeOwner(parent, uid);
      chmodSync(parent, 0o755);
      changeOwner(marker, uid);

      if (scenario.marker === "symlink") {
        changeOwner(target, uid);
      }
    }
  });
});
