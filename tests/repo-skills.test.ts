import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";
import { parseDocument, stringify } from "yaml";
import * as z from "zod";

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

function repoFixture() {
  const sandbox = makeTempDir("repo-skills");
  const repo = createRepo(path.join(sandbox, "consumer"), { "README.md": "Consumer\n" });
  const upstream = createRepo(path.join(sandbox, "upstream"), {
    "skills/first/SKILL.md": "---\nname: first\ndescription: First skill.\n---\nPinned first.\n",
    "skills/second/SKILL.md": "---\nname: second\ndescription: Second skill.\n---\nPinned second.\n"
  });
  const bin = path.join(sandbox, "bin");
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
  const messages: string[] = [];
  const runtime = createTestRuntime({
    cwd: repo,
    env: {
      HOME: path.join(sandbox, "home"),
      MONKE_HOME: path.join(sandbox, "monke"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`
    },
    onStderr() {},
    onStdout(message) {
      messages.push(message);
    }
  });
  return { bin, messages, repo, runtime, sandbox, upstream };
}

function installPartialSuccessImporter(bin: string) {
  writeExecutable(
    path.join(bin, "npx"),
    `#!/usr/bin/env bun
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const source = process.argv[5];
const selectors = [];
for (let index = 6; process.argv[index] === "--skill"; index += 2) selectors.push(process.argv[index + 1]);
let installed = 0;
for (const folder of readdirSync(path.join(source, "skills"))) {
  const directory = path.join(source, "skills", folder);
  const content = readFileSync(path.join(directory, "SKILL.md"), "utf8");
  const name = /^name: (.+)$/m.exec(content)[1];
  if (!selectors.includes("*") && !selectors.some(selector => selector.toLowerCase() === name.toLowerCase())) continue;
  const slug = name.toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^[.\\-]+|[.\\-]+$/g, "").substring(0, 255) || "unnamed-skill";
  const destination = path.join(".agents", "skills", slug);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(directory, destination, { recursive: true });
  installed += 1;
}
if (installed === 0) throw new Error("No matching skills: " + selectors.join(", "));
`
  );
}

describe("repo import recipes through mt skills", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["add", "update"])(
    "%s rejects an unwritable marker parent before changing accepted state",
    async (action) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const config = read(repo, "monke.yml");
      const first = read(repo, "skills/imported/first/SKILL.md");
      const marker = read(repo, "skills/.monke-restored.json");
      write(
        upstream,
        "skills/first/SKILL.md",
        "---\nname: first\ndescription: First skill.\n---\nCandidate first.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance unwritable marker source"]);
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? ["skills", "add", upstream, "--repo", "--skill", "first", "second"]
          : ["skills", "update", "--repo", "--adapter", "codiff"];
      chmodSync(path.join(repo, "skills"), 0o555);
      try {
        await expect(runCliAsync(args, runtime)).rejects.toThrow(/EACCES|marker/iu);
        expect(read(repo, "monke.yml")).toBe(config);
        expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
        expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
        expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      } finally {
        chmodSync(path.join(repo, "skills"), 0o755);
      }
    }
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["restore", "remove"])(
    "%s with matching restored files does not need marker-parent writes",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const other = createRepo(path.join(sandbox, "other-source"), {
        "skills/other/SKILL.md":
          "---\nname: other\ndescription: Other skill.\n---\nAccepted other.\n"
      });
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
      const marker = read(repo, "skills/.monke-restored.json");
      const acceptedOther = read(repo, "skills/imported/other/SKILL.md");
      writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 42\n");
      chmodSync(path.join(repo, "skills"), 0o555);
      try {
        await runCliAsync(
          ["skills", action, ...(action === "remove" ? [upstream] : []), "--repo"],
          runtime
        );
        const recipes = z
          .object({ skills: z.array(z.unknown()) })
          .parse(parseDocument(read(repo, "monke.yml")).toJS()).skills;
        expect(recipes).toHaveLength(action === "remove" ? 1 : 2);
        expect(read(repo, "skills/imported/other/SKILL.md")).toBe(acceptedOther);
        expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
        expect(existsSync(path.join(repo, "skills/imported/first"))).toBe(action !== "remove");
      } finally {
        chmodSync(path.join(repo, "skills"), 0o755);
      }
    }
  );

  test.each(["add", "update", "restore", "policy", "remove"])(
    "%s rejects an obstructed restore marker before changing accepted state",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const other = createRepo(path.join(sandbox, "other-source"), {
        "skills/other/SKILL.md":
          "---\nname: other\ndescription: Other skill.\n---\nAccepted other.\n"
      });
      await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
      write(
        upstream,
        "skills/first/SKILL.md",
        "---\nname: first\ndescription: First skill.\n---\nCandidate first.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance obstructed source"]);
      const marker = path.join(repo, "skills/.monke-restored.json");
      renameSync(marker, `${marker}.accepted`);
      write(marker, "obstruction", "Marker obstruction must survive.\n");
      if (action === "restore") {
        write(repo, "skills/imported/first/SKILL.md", "Local bytes before failed restore.\n");
      }
      const config = read(repo, "monke.yml");
      const first = read(repo, "skills/imported/first/SKILL.md");
      const acceptedOther = read(repo, "skills/imported/other/SKILL.md");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? ["skills", "add", upstream, "--repo", "--skill", "first", "second"]
          : action === "policy"
            ? ["skills", "policy", upstream, "first", "--repo", "--model-invocation", "deny"]
            : action === "remove"
              ? ["skills", "remove", upstream, "--repo"]
              : [
                  "skills",
                  action,
                  "--repo",
                  ...(action === "update" ? ["--adapter", "codiff"] : [])
                ];

      await expect(runCliAsync(args, runtime)).rejects.toThrow(/\.monke-restored\.json/u);

      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
      expect(read(repo, "skills/imported/other/SKILL.md")).toBe(acceptedOther);
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      expect(read(marker, "obstruction")).toBe("Marker obstruction must survive.\n");
    }
  );

  test.each(["symlink", "dangling symlink", "hardlink"])(
    "update atomically replaces a safe marker %s without changing its target",
    async (alias) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const marker = path.join(repo, "skills/.monke-restored.json");
      const original = read(repo, "skills/.monke-restored.json");
      const target = `${marker}.previous`;
      renameSync(marker, target);
      if (alias === "dangling symlink") {
        rmSync(target);
      }
      if (alias === "hardlink") {
        linkSync(target, marker);
      } else {
        symlinkSync(target, marker);
      }
      write(upstream, "skills/first/guide.md", "Accepted new guide.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance aliased marker source"]);
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);

      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);

      expect(read(repo, "skills/.monke-restored.json")).toContain(
        git(upstream, ["rev-parse", "HEAD"])
      );
      expect(read(repo, "skills/imported/first/guide.md")).toBe("Accepted new guide.\n");
      const targetContent = existsSync(target)
        ? read(repo, "skills/.monke-restored.json.previous")
        : undefined;
      expect(targetContent).toBe(alias === "dangling symlink" ? undefined : original);
    }
  );

  test("removing the last recipe and empty restore or update do not need a restore marker", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const marker = path.join(repo, "skills/.monke-restored.json");
    renameSync(marker, `${marker}.accepted`);
    write(marker, "obstruction", "Marker obstruction must survive.\n");
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    await runCliAsync(["skills", "remove", upstream, "--repo"], runtime);
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);

    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({ skills: [] });
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    expect(read(marker, "obstruction")).toBe("Marker obstruction must survive.\n");
  });

  test.each([
    { nested: false, readd: false },
    { nested: false, readd: true },
    { nested: true, readd: false },
    { nested: true, readd: true }
  ])(
    "repo add rejects a partially matched selection with nested=$nested readd=$readd",
    async ({ nested, readd }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      installPartialSuccessImporter(bin);
      const publisher = createRepo(path.join(sandbox, "publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/own/SKILL.md": "---\nname: own\ndescription: Own skill.\n---\nOwn guidance.\n"
      });
      const source = `${nested ? publisher : upstream}#HEAD`;
      const valid = nested ? "own" : "first";
      const missing = nested ? "first" : "unavailable";
      write(repo, "monke.yml", "# Keep consumer settings.\napps: {}\n");
      if (readd) {
        await runCliAsync(["skills", "add", source, "--repo", "--skill", valid], runtime);
      }
      const config = read(repo, "monke.yml");
      const imported = path.join(repo, "skills/imported", valid, "SKILL.md");
      const accepted = existsSync(imported) ? read(repo, path.relative(repo, imported)) : undefined;
      await expect(
        runCliAsync(["skills", "add", source, "--repo", "--skill", valid, missing], runtime)
      ).rejects.toThrow(missing);
      expect(read(repo, "monke.yml")).toBe(config);
      expect(existsSync(imported) ? read(repo, path.relative(repo, imported)) : undefined).toBe(
        accepted
      );
      expect(existsSync(path.join(repo, "skills/imported", missing))).toBeFalsy();
    }
  );

  test("repo selectors match raw upstream names without case sensitivity and wildcard selects all", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    installPartialSuccessImporter(bin);
    write(
      upstream,
      "skills/different-folder/SKILL.md",
      "---\nname: Fancy Author\ndescription: Named skill.\n---\nNamed instructions.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Publish named skill"]);
    const source = `${upstream}#HEAD`;
    await runCliAsync(
      ["skills", "add", source, "--repo", "--skill", "FIRST", "fAnCy AuThOr"],
      runtime
    );
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({
      skills: [
        {
          commit: git(upstream, ["rev-parse", "HEAD"]),
          skills: [{ selector: "Fancy Author", slug: "fancy-author" }, "first"],
          source
        }
      ]
    });
    expect(read(repo, "skills/imported/fancy-author/SKILL.md")).toContain("Named instructions.");
    const accepted = read(repo, "monke.yml");
    await expect(
      runCliAsync(["skills", "add", source, "--repo", "--skill", "first", "fancy-author"], runtime)
    ).rejects.toThrow("fancy-author");
    expect(read(repo, "monke.yml")).toBe(accepted);
    await runCliAsync(["skills", "add", source, "--repo", "--skill", "*", "unavailable"], runtime);
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("Pinned second.");
    expect(read(repo, "monke.yml")).not.toContain("unavailable");
  });

  test("repo re-add, update, and restore reject a partially matched retained selection", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    installPartialSuccessImporter(bin);
    const source = `${upstream}#HEAD`;
    await runCliAsync(["skills", "add", source, "--repo", "--skill", "first", "second"], runtime);
    const config = read(repo, "monke.yml");
    const first = read(repo, "skills/imported/first/SKILL.md");
    const second = read(repo, "skills/imported/second/SKILL.md");
    rmSync(path.join(upstream, "skills/second"), { recursive: true });
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nUnaccepted revision.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Retire selected skill"]);
    await expect(runCliAsync(["skills", "add", source, "--repo"], runtime)).rejects.toThrow(
      "second"
    );
    expect(read(repo, "monke.yml")).toBe(config);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow("second");
    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
    expect(read(repo, "skills/imported/second/SKILL.md")).toBe(second);
    const edited = stringify({
      skills: [
        { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first", "second"], source }
      ]
    });
    write(repo, "monke.yml", edited);
    await expect(runCliAsync(["skills", "restore", "--repo"], runtime)).rejects.toThrow(
      /slugs changed/u
    );
    expect(read(repo, "monke.yml")).toBe(edited);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
    expect(read(repo, "skills/imported/second/SKILL.md")).toBe(second);
  });

  test("repo declarations select their source's own skills and Git and linked consumers resolve one level", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    const publisher = createRepo(path.join(sandbox, "publisher-b"), {
      "monke.yml": stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
        ]
      }),
      "skills/own-b/SKILL.md": "---\nname: own-b\ndescription: B skill.\n---\nB first revision.\n"
    });
    write(
      repo,
      "skills/own-a/SKILL.md",
      "---\nname: own-a\ndescription: A skill.\n---\nA guidance.\n"
    );
    const source = `${publisher}#HEAD`;
    await runCliAsync(["skills", "add", source, "--repo"], runtime);
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({
      skills: [{ commit: git(publisher, ["rev-parse", "HEAD"]), skills: ["own-b"], source }]
    });
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain("B first revision.");
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Publish B own guidance"]);
    const before = git(repo, ["rev-parse", "HEAD"]);

    // B's declaration is outside A's import depth and must never be fetched.
    renameSync(upstream, `${upstream}-offline`);
    rmSync(path.join(repo, "skills/imported/own-b"), { recursive: true });
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    await runCliAsync(
      [
        "skills",
        "policy",
        source,
        "own-b",
        "--repo",
        "--description",
        "A trigger.",
        "--model-invocation",
        "deny"
      ],
      runtime
    );
    write(
      publisher,
      "skills/own-b/SKILL.md",
      "---\nname: own-b\ndescription: B skill.\n---\nB second revision.\n"
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Advance B own guidance"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain("B second revision.");
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain("description: A trigger.");
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Publish updated B guidance"]);
    const after = git(repo, ["rev-parse", "HEAD"]);
    const history = await runtime.execAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/review-skills.ts", import.meta.url)),
      before,
      after,
      "--adapter",
      "codiff"
    ]);
    expect(history.stdout).toContain("Complete skill review:");

    for (const kind of ["git", "link"] as const) {
      const consumer = createRepo(path.join(sandbox, `consumer-${kind}`), {
        "README.md": "Consumer.\n"
      });
      const consumerRuntime = createTestRuntime({
        cwd: consumer,
        env: runtime.env,
        onStderr() {},
        onStdout() {}
      });
      await runCliAsync(
        kind === "git"
          ? ["skills", "add", `${repo}#HEAD`, "--project"]
          : ["skills", "add", repo, "--project", "--link", "--name", "publisher-a"],
        consumerRuntime
      );
      const projected = path.join(consumer, ".agents/skills/monke-tools/imported");
      expect(read(projected, "own-a/SKILL.md")).toContain("A guidance.");
      expect(read(projected, "own-b/SKILL.md")).toContain("B second revision.");
      expect(read(projected, "own-b/SKILL.md")).toContain("description: A trigger.");
      expect(existsSync(path.join(projected, "first"))).toBeFalsy();
    }
    await runCliAsync(["skills", "remove", source, "--repo"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/own-b"))).toBeFalsy();
    expect(read(repo, "skills/own-a/SKILL.md")).toContain("A guidance.");
  });

  test("wildcard imports discover upstream hidden catalogs", async () => {
    const { bin, repo, runtime, sandbox } = repoFixture();
    const upstream = createRepo(path.join(sandbox, "curated-source"), {
      "skills/.curated/base/SKILL.md":
        "---\nname: base\ndescription: Curated skill.\n---\nCurated.\n"
    });
    writeExecutable(
      path.join(bin, "npx"),
      '#!/bin/sh\nset -eu\nmkdir -p .agents/skills\ncp -R "$4/skills/.curated/base" .agents/skills/\n'
    );
    await runCliAsync(["skills", "add", upstream, "--repo"], runtime);
    expect(read(repo, "skills/imported/base/SKILL.md")).toContain("Curated.");
    expect(read(repo, "monke.yml")).toContain("base");
  });

  test.each(["add", "restore", "update"])(
    "repo %s rejects selections available only through its source's declarations",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const publisher = createRepo(path.join(sandbox, "publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/own/SKILL.md":
          "---\nname: own\ndescription: Own skill.\n---\nAccepted own guidance.\n"
      });
      const source = `${publisher}#HEAD`;
      const commit = git(publisher, ["rev-parse", "HEAD"]);
      await runCliAsync(["skills", "add", source, "--repo", "--skill", "own"], runtime);
      const accepted = read(repo, "skills/imported/own/SKILL.md");
      if (action !== "add") {
        write(repo, "monke.yml", stringify({ skills: [{ commit, skills: ["first"], source }] }));
      }
      const config = read(repo, "monke.yml");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? ["skills", "add", source, "--repo", "--skill", "first"]
          : ["skills", action, "--repo", ...(action === "update" ? ["--adapter", "codiff"] : [])];
      await expect(runCliAsync(args, runtime)).rejects.toThrow(/first/u);
      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/imported/own/SKILL.md")).toBe(accepted);
      expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    }
  );

  test("a failed replacement selection keeps accepted files while another source advances", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    const other = createRepo(path.join(sandbox, "other"), {
      "skills/other/SKILL.md":
        "---\nname: other\ndescription: Other skill.\n---\nOther first revision.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
    const failedPin = git(upstream, ["rev-parse", "HEAD"]);
    const accepted = read(repo, "skills/imported/first/SKILL.md");
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [
          { commit: failedPin, skills: ["unpublished"], source: upstream },
          { commit: git(other, ["rev-parse", "HEAD"]), skills: ["other"], source: other }
        ]
      })
    );
    write(
      other,
      "skills/other/SKILL.md",
      "---\nname: other\ndescription: Other skill.\n---\nOther second revision.\n"
    );
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "Advance working source"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow("1 recipe(s)");
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(accepted);
    expect(existsSync(path.join(repo, "skills/imported/unpublished"))).toBeFalsy();
    expect(read(repo, "skills/imported/other/SKILL.md")).toContain("Other second revision.");
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({
      skills: [
        { commit: git(other, ["rev-parse", "HEAD"]), skills: ["other"], source: other },
        { commit: failedPin, skills: ["unpublished"], source: upstream }
      ]
    });
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [{ commit: git(other, ["rev-parse", "HEAD"]), skills: ["other"], source: other }]
      })
    );
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
  });

  test.each([false, true])(
    "publisher collisions use installed names with explicit=%s",
    async (explicit) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const registry = path.join(repo, ".git/monke-tools/skill-registry");
      const projected = path.join(repo, ".agents/skills/monke-tools/imported");
      const publisher = createRepo(path.join(sandbox, "named-publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/first/SKILL.md":
          "---\nname: repo-author\ndescription: Publisher skill.\n---\nOwn guidance.\n"
      });
      writeExecutable(
        path.join(bin, "npx"),
        `#!/bin/sh
set -eu
mkdir -p .agents/skills
if grep -q '^name: repo-author$' "$4/skills/first/SKILL.md"; then
  cp -R "$4/skills/first" .agents/skills/repo-author
else
  cp -R "$4/skills/first" .agents/skills/first
fi
`
      );
      await runCliAsync(
        [
          "skills",
          "add",
          `${publisher}#HEAD`,
          "--project",
          ...(explicit ? ["--skill", "first"] : [])
        ],
        runtime
      );
      expect(read(projected, "first/SKILL.md")).toContain("Pinned first.");
      expect(existsSync(path.join(projected, "repo-author"))).toBe(!explicit);
      write(
        publisher,
        "skills/first/SKILL.md",
        "---\nname: first\ndescription: Colliding skill.\n---\nCollision.\n"
      );
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Introduce installed slug collision"]);
      const accepted = read(registry, "skills.lock.json");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      await expect(
        runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime)
      ).rejects.toThrow(/collid/u);
      expect(read(registry, "skills.lock.json")).toBe(accepted);
      expect(read(projected, "first/SKILL.md")).toContain("Pinned first.");
    }
  );

  test.each([false, true])(
    "wildcard publishers retain declared imports with internal skills enabled=%s",
    async (includeInternal) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const projected = path.join(repo, ".agents/skills/monke-tools/imported");
      const publisher = createRepo(path.join(sandbox, "internal-publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/internal/SKILL.md":
          "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nInternal.\n"
      });
      writeExecutable(
        path.join(bin, "npx"),
        `#!/bin/sh
set -eu
mkdir -p .agents/skills
if [ -f "$4/skills/internal/SKILL.md" ]; then
  [ "$INSTALL_INTERNAL_SKILLS" = 1 ]
  cp -R "$4/skills/internal" .agents/skills/
else
  cp -R "$4/skills/first" .agents/skills/
fi
`
      );
      if (includeInternal) {
        runtime.env.INSTALL_INTERNAL_SKILLS = "1";
      }
      await runCliAsync(["skills", "add", `${publisher}#HEAD`, "--project"], runtime);
      expect(read(projected, "first/SKILL.md")).toContain("Pinned first.");
      expect(existsSync(path.join(projected, "internal"))).toBe(includeInternal);
    }
  );

  test.each([
    { action: "add", alias: "symlink" },
    { action: "restore", alias: "symlink" },
    { action: "update", alias: "symlink" },
    { action: "remove", alias: "symlink" },
    { action: "policy", alias: "symlink" },
    { action: "add", alias: "hardlink" }
  ])(
    "$action rejects a $alias .gitignore before changing accepted state",
    async ({ action, alias }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const acceptedConfig = read(repo, "monke.yml");
      const acceptedSkill = read(repo, "skills/imported/first/SKILL.md");
      const external = path.join(sandbox, "external-ignore");
      write(sandbox, "external-ignore", "External ignores must survive.\n");
      renameSync(path.join(repo, ".gitignore"), path.join(repo, "original-ignore"));
      if (alias === "hardlink") {
        linkSync(external, path.join(repo, ".gitignore"));
      } else {
        symlinkSync(external, path.join(repo, ".gitignore"));
      }
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args = ["skills", action];
      if (["add", "remove", "policy"].includes(action)) {
        args.push(upstream);
      }
      args.push("--repo");
      if (action === "add") {
        args.push("--skill", "second");
      }
      if (action === "policy") {
        args.push("--model-invocation", "deny");
      }
      if (action === "update") {
        args.push("--adapter", "codiff");
      }
      await expect(runCliAsync(args, runtime)).rejects.toThrow(/\.gitignore.*regular file/u);
      expect(read(sandbox, "external-ignore")).toBe("External ignores must survive.\n");
      expect(read(repo, "monke.yml")).toBe(acceptedConfig);
      expect(read(repo, "skills/imported/first/SKILL.md")).toBe(acceptedSkill);
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
    }
  );

  test.each(["skills.lock.json", "skills/imported/.monke-imports.json"])(
    "repo restore and update obey YAML over %s",
    async (legacyFile) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      const commit = git(upstream, ["rev-parse", "HEAD"]);
      const legacy = JSON.stringify({
        recipes: [
          {
            commit,
            skills: ["first"],
            source: upstream
          }
        ],
        version: 4
      });
      write(repo, legacyFile, legacy);
      const config = stringify({
        skills: [
          {
            commit,
            skills: [
              {
                description: "YAML trigger.",
                modelInvocation: "deny",
                slug: "second"
              }
            ],
            source: upstream
          }
        ]
      });
      write(repo, "monke.yml", config);
      await runCliAsync(["skills", "restore", "--repo"], runtime);
      expect(read(repo, "skills/imported/second/SKILL.md")).toContain("description: YAML trigger.");
      expect(read(repo, "skills/imported/second/SKILL.md")).toContain(
        "disable-model-invocation: true"
      );
      expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
      write(upstream, "skills/second/guide.md", "New accepted guide.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance YAML-selected guidance"]);
      const reviewLog = installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
      expect(read(repo, "skills/imported/second/guide.md")).toBe("New accepted guide.\n");
      expect(read(repo, "monke.yml")).toContain("YAML trigger.");
      expect(read(repo, "monke.yml")).not.toContain("first");
      const [, reviewCommit = "", reviewRepo = ""] = read(bin, path.relative(bin, reviewLog))
        .trim()
        .split("\n");
      const reviewedStore = git(reviewRepo, ["show", `${reviewCommit}:skills.lock.json`]);
      expect(reviewedStore).toContain("second");
      expect(reviewedStore).not.toContain("first");
      write(repo, "monke.yml", "# No repo imports remain.\n");
      await runCliAsync(["skills", "restore", "--repo"], runtime);
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
      expect(read(repo, "monke.yml")).toBe("# No repo imports remain.\n");
      expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    }
  );

  test.each([
    { action: "add", kind: "skill" },
    { action: "restore", kind: "skill" },
    { action: "update", kind: "skill" },
    { action: "add", kind: "reference" },
    { action: "restore", kind: "reference" },
    { action: "update", kind: "reference" }
  ] as const)(
    "$action rejects a symlinked $kind root before changing external files",
    async ({ action, kind }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const config = stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            skills: [{ kind, slug: "first" }],
            source: upstream
          }
        ]
      });
      write(repo, "monke.yml", config);
      const external = path.join(sandbox, "external");
      const entry = `first/${kind === "reference" ? "MAIN.md" : "SKILL.md"}`;
      write(external, entry, "External content must survive.\n");
      const root = path.join(
        repo,
        kind === "reference" ? "skills/references/imported" : "skills/imported"
      );
      mkdirSync(path.dirname(root), { recursive: true });
      symlinkSync(external, root, "dir");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? [
              "skills",
              action,
              upstream,
              "--repo",
              "--skill",
              "first",
              ...(kind === "reference" ? ["--ref"] : [])
            ]
          : ["skills", action, "--repo", ...(action === "update" ? ["--adapter", "codiff"] : [])];
      await expect(runCliAsync(args, runtime)).rejects.toThrow(/root must be a regular directory/u);
      expect(read(external, entry)).toBe("External content must survive.\n");
      expect(read(repo, "monke.yml")).toBe(config);
    }
  );

  test("add pins a compact declaration, preserves YAML, and restores ignored guidance", async () => {
    const { repo, runtime, upstream } = repoFixture();
    const original = "# Keep this comment\nbootstrapCommand: 'echo setup' # Keep this too\n";
    write(repo, "monke.yml", original);
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const config = read(repo, "monke.yml");
    expect(config.startsWith(original)).toBeTruthy();
    expect(
      z.object({ skills: z.array(z.unknown()) }).parse(parseDocument(config).toJS()).skills
    ).toStrictEqual([
      { commit: git(upstream, ["rev-parse", "HEAD"]).trim(), skills: ["first"], source: upstream }
    ]);
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Pinned first.");
    expect(git(repo, ["check-ignore", "skills/imported/first/SKILL.md"]).trim()).toBe(
      "skills/imported/first/SKILL.md"
    );
    expect(existsSync(path.join(repo, "skills.lock.json"))).toBeFalsy();
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, ".gitignore").split("/skills/imported/")).toHaveLength(2);
  });

  test("hand edits restore new selections at their pin, reapply overrides, prune removals, and replace local edits", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    const commit = git(upstream, ["rev-parse", "HEAD"]);
    write(
      repo,
      "monke.yml",
      stringify({ skills: [{ commit, skills: ["first"], source: upstream }] })
    );
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    write(upstream, "skills/second/SKILL.md", "---\nname: second\n---\nNew upstream revision.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance upstream"]);
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [
          {
            commit,
            modelInvocation: "deny",
            skills: [
              "first",
              { description: "Retuned description.", modelInvocation: "allow", slug: "second" }
            ],
            source: upstream
          }
        ]
      })
    );
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("Pinned second.");
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain(
      "description: Retuned description."
    );
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain(
      "disable-model-invocation: false"
    );
    const config = stringify({ skills: [{ commit, skills: ["second"], source: upstream }] });
    write(repo, "monke.yml", config);
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    write(repo, "skills/imported/second/SKILL.md", "Edited locally.\n");
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("Pinned second.");
    renameSync(upstream, `${upstream}-offline`);
    writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 42\n");
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "monke.yml")).toBe(config);
  });

  test("restore refuses an unpinned entry and update pins it with one comparison", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    write(repo, "monke.yml", stringify({ skills: [{ skills: ["first"], source: upstream }] }));
    await expect(runCliAsync(["skills", "restore", "--repo"], runtime)).rejects.toThrow(
      "mt skills update --repo"
    );
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Pinned first.");
    expect(read(repo, path.relative(repo, reviewLog))).toContain("--commit");
  });

  test("update accepts a handwritten selection first published after its recorded pin", async () => {
    const { bin, repo, runtime, sandbox } = repoFixture();
    const upstream = createRepo(path.join(sandbox, "expanded-source"), {
      "skills/first/SKILL.md": "---\nname: first\ndescription: First skill.\n---\nOriginal first.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const originalPin = git(upstream, ["rev-parse", "HEAD"]);
    const originalFirst = read(repo, "skills/imported/first/SKILL.md");
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nUpdated first.\n"
    );
    write(
      upstream,
      "skills/second/SKILL.md",
      "---\nname: second\ndescription: Second skill.\n---\nNew second.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Publish second skill"]);
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [{ commit: originalPin, skills: ["first", "second"], source: upstream }]
      })
    );
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);

    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Updated first.");
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("New second.");
    const [, reviewCommit = "", reviewRepo = ""] = read(bin, path.relative(bin, reviewLog))
      .trim()
      .split("\n");
    expect(git(reviewRepo, ["show", `${reviewCommit}^:skills/imported/first/SKILL.md`])).toBe(
      originalFirst.trimEnd()
    );
    expect(
      git(reviewRepo, ["ls-tree", "--name-only", `${reviewCommit}^`, "skills/imported/second"])
    ).toBe("");
    expect(git(reviewRepo, ["show", `${reviewCommit}:skills/imported/second/SKILL.md`])).toContain(
      "New second."
    );
  });

  test("a failed expanded selection retains its recorded pin and accepted files", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const originalPin = git(upstream, ["rev-parse", "HEAD"]);
    const originalFirst = read(repo, "skills/imported/first/SKILL.md");
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nCandidate first.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance without the selected skill"]);
    const config = stringify({
      skills: [{ commit: originalPin, skills: ["first", "unpublished"], source: upstream }]
    });
    write(repo, "monke.yml", config);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow("unpublished");

    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(originalFirst);
    expect(existsSync(path.join(repo, "skills/imported/unpublished"))).toBeFalsy();
  });

  test("reference imports and policy and remove commands update the repo declaration", async () => {
    const { repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--ref", "--skill", "first"], runtime);
    expect(read(repo, "skills/references/imported/first/MAIN.md")).toBe("Pinned first.\n");
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first", "second"], runtime);
    await runCliAsync(
      [
        "skills",
        "policy",
        upstream,
        "second",
        "--repo",
        "--description",
        "New trigger.",
        "--model-invocation",
        "deny"
      ],
      runtime
    );
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("description: New trigger.");
    expect(read(repo, "monke.yml")).toContain("modelInvocation: deny");
    await runCliAsync(["skills", "remove", upstream, "--repo"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({ skills: [] });
  });

  test("repo reference choices remain authoritative for a source's own skills", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    const publisher = createRepo(path.join(sandbox, "reference-publisher"), {
      "monke.yml": stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            skills: ["first"],
            source: upstream
          }
        ]
      }),
      "skills/own/SKILL.md": "---\nname: own\ndescription: Own skill.\n---\nOwn instructions.\n"
    });
    await runCliAsync(
      ["skills", "add", `${publisher}#HEAD`, "--repo", "--ref", "--skill", "own"],
      runtime
    );
    write(publisher, "README.md", "Publisher advances.\n");
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Advance publisher"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "skills/references/imported/own/MAIN.md")).toBe("Own instructions.\n");
    expect(existsSync(path.join(repo, "skills/imported/own"))).toBeFalsy();
    await expect(
      runCliAsync(["skills", "add", `${publisher}#HEAD`, "--ref"], runtime)
    ).rejects.toThrow("--ref requires --repo");
  });

  test("update prepares Git sources concurrently and prunes guidance removed by hand", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const sources = Array.from({ length: 5 }, (_, index) => {
      const slug = `concurrent-${index}`;
      const source = createRepo(path.join(sandbox, slug), {
        [`skills/${slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: Concurrent skill.\n---\n${slug}.\n`
      });
      return { skills: [slug], source };
    });
    write(repo, "monke.yml", stringify({ skills: sources }));
    writeExecutable(
      path.join(bin, "npx"),
      `#!${process.execPath}
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const slug = args[args.indexOf("--skill") + 1];
const index = Number(slug.split("-")[1]);
const barrier = ${JSON.stringify(sandbox)};
writeFileSync(path.join(barrier, "entered-" + index), "");
if (index < 4) {
  const deadline = Date.now() + 5000;
  while (![0, 1, 2, 3].every((item) => existsSync(path.join(barrier, "entered-" + item)))) {
    if (Date.now() > deadline) throw new Error("Git source preparation did not overlap");
    await Bun.sleep(10);
  }
}
mkdirSync(".agents/skills", { recursive: true });
cpSync(path.join(args[3], "skills", slug), path.join(".agents/skills", slug), { recursive: true });
`
    );
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    for (const {
      skills: [slug]
    } of sources) {
      expect(read(repo, `skills/imported/${slug}/SKILL.md`)).toContain(`${slug}.`);
    }
    expect(read(repo, path.relative(repo, reviewLog)).split("--commit")).toHaveLength(2);
  });

  test("update advances successful sources, retains failed pins, and opens one complete review", async () => {
    const { bin, messages, repo, runtime, sandbox, upstream } = repoFixture();
    const other = createRepo(path.join(sandbox, "other"), {
      "skills/other/SKILL.md": "---\nname: other\ndescription: Other skill.\n---\nOther content.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
    await runCliAsync(
      ["skills", "policy", upstream, "--repo", "--model-invocation", "deny"],
      runtime
    );
    const previousPin = git(other, ["rev-parse", "HEAD"]);
    renameSync(other, `${other}-unavailable`);
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nAdvanced first.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance successful source"]);
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow(other);
    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "monke.yml")).toContain(previousPin);
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Advanced first.");
    expect(read(repo, "skills/imported/other/SKILL.md")).toContain("Other content.");
    expect(read(repo, path.relative(repo, reviewLog)).split("--commit")).toHaveLength(2);
    expect(messages.join("")).toContain("# Skill update summary");
  });
});
