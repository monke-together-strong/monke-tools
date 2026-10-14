import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { stringify } from "yaml";

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

function fixture() {
  const sandbox = makeTempDir("linked-publisher");
  const consumer = createRepo(path.join(sandbox, "consumer"), { "README.md": "Consumer.\n" });
  const upstream = createRepo(path.join(sandbox, "upstream"), {
    "skills/base/SKILL.md":
      "---\nname: base\ndescription: Upstream trigger.\n---\nBase instructions.\n"
  });
  const publisher = createRepo(path.join(sandbox, "publisher"), {
    "skills/own/SKILL.md": "---\nname: own\ndescription: Own trigger.\n---\nOwn instructions.\n"
  });
  const bin = path.join(sandbox, "bin");
  installFakeCodiff(bin);
  installFakeCodexSummary(bin);
  writeExecutable(
    path.join(bin, "npx"),
    `#!/bin/sh
set -eu
source="$4"
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R "$source/skills/"* .agents/skills/;
  else cp -R "$source/skills/$2" .agents/skills/; fi
  shift 2
done
`
  );
  const runtime = createTestRuntime({
    cwd: consumer,
    env: {
      HOME: path.join(sandbox, "home"),
      MONKE_HOME: path.join(sandbox, "monke-home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`
    },
    onStderr() {},
    onStdout() {}
  });
  function declare(kind: "reference" | "skill", slug = "base") {
    write(
      publisher,
      "monke.yml",
      stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            modelInvocation: "deny",
            skills: [{ description: "Publisher trigger.", kind, selector: "base", slug }],
            source: upstream
          }
        ]
      })
    );
  }
  declare("reference");
  const installed = path.join(consumer, ".agents/skills/monke-tools");
  return { consumer, declare, installed, publisher, runtime };
}

describe("linked publisher collections", () => {
  test("default selection publishes declared references beside linked own skills", async () => {
    const { installed, publisher, runtime } = fixture();
    await runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime);
    expect(read(installed, "references/imported/base/MAIN.md")).toBe("Base instructions.\n");
    expect(existsSync(path.join(installed, "imported/base/SKILL.md"))).toBeFalsy();
    expect(realpathSync(path.join(installed, "imported/own"))).toBe(
      realpathSync(path.join(publisher, "skills/own"))
    );
    expect(
      lstatSync(path.join(publisher, "skills/references/imported/base")).isDirectory()
    ).toBeTruthy();
    expect(git(publisher, ["check-ignore", "skills/references/imported/base/MAIN.md"])).toBe(
      "skills/references/imported/base/MAIN.md"
    );
  });

  test("selection can install only a declared reference", async () => {
    const { installed, publisher, runtime } = fixture();
    await runCliAsync(
      ["skills", "add", publisher, "--link", "--project", "--skill", "base"],
      runtime
    );
    expect(read(installed, "references/imported/base/MAIN.md")).toBe("Base instructions.\n");
    expect(existsSync(path.join(installed, "imported/own"))).toBeFalsy();
  });

  test("a declared reference collision fails before restoring or publishing guidance", async () => {
    const { consumer, declare, installed, publisher, runtime } = fixture();
    declare("reference", "own");
    await expect(
      runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime)
    ).rejects.toThrow(/own.*collides/u);
    expect(existsSync(path.join(installed, "imported/own"))).toBeFalsy();
    expect(existsSync(path.join(publisher, "skills/references/imported/own"))).toBeFalsy();
    expect(read(consumer, ".git/monke-tools/skill-registry/skills.lock.json")).toContain(
      '"recipes": []'
    );
  });

  test("updates follow publisher kind changes and preserve consumer metadata overrides", async () => {
    const { declare, installed, publisher, runtime } = fixture();
    await runCliAsync(
      ["skills", "add", publisher, "--link", "--project", "--skill", "base"],
      runtime
    );
    declare("skill");
    await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
    expect(read(installed, "imported/base/SKILL.md")).toContain("description: Publisher trigger.");
    expect(read(installed, "imported/base/SKILL.md")).toContain("disable-model-invocation: true");
    expect(existsSync(path.join(installed, "references/imported/base"))).toBeFalsy();
    await runCliAsync(
      [
        "skills",
        "policy",
        "publisher",
        "base",
        "--project",
        "--description",
        "Consumer trigger.",
        "--model-invocation",
        "allow"
      ],
      runtime
    );
    await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
    expect(read(installed, "imported/base/SKILL.md")).toContain("description: Consumer trigger.");
    expect(read(installed, "imported/base/SKILL.md")).toContain("disable-model-invocation: false");
  });

  test.each(["readd", "update"])(
    "%s replaces a retired import with an own skill",
    async (action) => {
      const { declare, installed, publisher, runtime } = fixture();
      const add = ["skills", "add", publisher, "--link", "--project"];
      declare("skill");
      await runCliAsync(add, runtime);
      write(publisher, "monke.yml", "skills: []\n");
      write(
        publisher,
        "skills/base/SKILL.md",
        "---\nname: base\ndescription: Own base.\n---\nOwn base instructions.\n"
      );
      await runCliAsync(action === "readd" ? add : ["skills", "update", "--project"], runtime);
      expect(read(installed, "imported/base/SKILL.md")).toContain("Own base instructions.");
      expect(realpathSync(path.join(installed, "imported/base"))).toBe(
        realpathSync(path.join(publisher, "skills/base"))
      );
      expect(existsSync(path.join(publisher, "skills/imported/base"))).toBeFalsy();

      rmSync(path.join(publisher, "skills/base"), { recursive: true });
      declare("skill");
      await runCliAsync(action === "readd" ? add : ["skills", "update", "--project"], runtime);
      expect(read(installed, "imported/base/SKILL.md")).toContain("Base instructions.");
      expect(read(installed, "imported/base/SKILL.md")).toContain(
        "description: Publisher trigger."
      );
    }
  );
});
