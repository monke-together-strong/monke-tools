import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import { createRepo, makeTempDir, read, runMonke, write } from "./helpers.ts";

describe("resource lifecycle", () => {
  test("explicit resources can be acquired, released and reacquired without removing the worktree", () => {
    const sandbox = makeTempDir("resource-lifecycle");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\nallocation-count\nreleased\n",
      "monke.yml":
        "apps: {}\ncleanupCommand: 'echo released >> released'\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n",
      "slot.ts": `export default async function () {
      const file = Bun.file("allocation-count");
      const count = await file.exists() ? Number(await file.text()) : 0;
      await Bun.write("allocation-count", String(count + 1));
      return { SLOT: String(count + 1) };
    }`
    });
    runMonke({ args: ["spawn", "feature"], cwd: root, monkeHome: home });
    const cwd = getExpectedWorktreePath(home, root, "feature");
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    expect(existsSync(path.join(cwd, "allocation-count"))).toBeFalsy();
    run("resources", "acquire");
    run("resources", "acquire");
    run("materialize");
    expect(read(cwd, "allocation-count")).toBe("1");
    expect(read(cwd, ".env")).toContain("SLOT=1");
    run("resources", "release");
    run("resources", "release");
    expect(existsSync(cwd)).toBeTruthy();
    expect(read(cwd, "released")).toBe("released\n");
    expect(read(cwd, ".env")).not.toContain("SLOT=");
    run("resources", "acquire");
    expect(read(cwd, ".env")).toContain("SLOT=2");
    run("chop");
    expect(existsSync(cwd)).toBeFalsy();
  });

  test("failed acquisition retains completed allocations and failed release retains cleanup authority", () => {
    const sandbox = makeTempDir("resource-recovery");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\nready\ncleanup-ready\nfirst-count\n",
      "first.ts":
        'export default async function () { const f = Bun.file("first-count"); const n = await f.exists() ? Number(await f.text()) : 0; await Bun.write("first-count", String(n + 1)); return { FIRST: "one" }; }',
      "monke.yml":
        "apps: {}\ncleanupCommand: test -f cleanup-ready\nresources:\n  commands:\n    first:\n      acquire: explicit\n      run: first.ts\n      outputs: [FIRST]\n    second:\n      acquire: explicit\n      run: second.ts\n      outputs: [SECOND]\n",
      "second.ts":
        'export default async function () { if (!await Bun.file("ready").exists()) throw new Error("not ready"); return { SECOND: "two" }; }'
    });
    runMonke({ args: ["spawn", "feature"], cwd: root, monkeHome: home });
    const cwd = getExpectedWorktreePath(home, root, "feature");
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    expect(() => run("resources", "acquire")).toThrow(/not ready/u);
    write(cwd, "ready", "yes");
    run("resources", "acquire");
    expect(read(cwd, "first-count")).toBe("1");
    expect(() => run("resources", "release")).toThrow(/Cleanup command failed/u);
    expect(read(cwd, ".env")).toContain("FIRST=one");
    run("resources", "acquire");
    expect(read(cwd, "first-count")).toBe("1");
    write(cwd, "cleanup-ready", "yes");
    run("resources", "release");
    expect(read(cwd, ".env")).not.toContain("FIRST=");
  });

  test("resource operations reject a source checkout and arguments", () => {
    const sandbox = makeTempDir("resource-target");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "repo"), { "monke.yml": "apps: {}\n" });
    for (const operation of ["acquire", "release"]) {
      expect(() =>
        runMonke({ args: ["resources", operation], cwd: root, monkeHome: home })
      ).toThrow(/Session worktree/u);
      expect(() =>
        runMonke({ args: ["resources", operation, "slot"], cwd: root, monkeHome: home })
      ).toThrow(/too many arguments/u);
    }
  });
});

describe("resource ownership", () => {
  test("dependency acquisition stays local and release makes its allocation available to another Session", () => {
    const sandbox = makeTempDir("resource-dependency");
    const home = path.join(sandbox, "home");
    const dep = createRepo(path.join(sandbox, "dep"), {
      ".env.local": "PORT=5432\n",
      ".gitignore": ".env\n",
      "monke.yml":
        "apps:\n  db:\n    path: .\n    envFile: .env.local\n    mappings:\n      - port: DB_PORT\n        env: PORT\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n",
      "slot.ts":
        "export default function ({ previous }) { let slot = 1; while (previous.SLOT.includes(String(slot))) slot++; return { SLOT: String(slot) }; }"
    });
    const root = createRepo(path.join(sandbox, "root"), {
      ".env": "DB_PORT=5432\n",
      ".gitignore": ".env\n",
      "monke.yml":
        "apps:\n  app:\n    path: .\n    mappings: []\nexternal:\n  dep:\n    path: ../dep\n    pathEnv: DEP_DIR\n    mappings:\n      - port: DB_PORT\n        app: app\n        env: DB_PORT\n"
    });
    for (const session of ["one", "two"]) {
      runMonke({ args: ["spawn", session], cwd: root, monkeHome: home });
    }
    const first = getExpectedWorktreePath(home, dep, "one");
    const second = getExpectedWorktreePath(home, dep, "two");
    const invoke = (cwd: string, operation: string) =>
      runMonke({ args: ["resources", operation], cwd, monkeHome: home });
    invoke(first, "acquire");
    invoke(second, "acquire");
    expect(read(first, ".env")).toContain("SLOT=1");
    expect(read(second, ".env")).toContain("SLOT=2");
    invoke(getExpectedWorktreePath(home, root, "one"), "release");
    expect(read(first, ".env")).toContain("SLOT=1");
    invoke(first, "release");
    invoke(second, "release");
    invoke(second, "acquire");
    expect(read(second, ".env")).toContain("SLOT=1");
  });
});

describe("cleanup authority", () => {
  test("acquire preserves unreleased inputs when configuration removes resources", () => {
    const sandbox = makeTempDir("resource-authority");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\nreleased\n",
      "monke.yml":
        'apps: {}\ncleanupCommand: \'test "$SLOT" = one && test "$OWNER" = original && echo done > released\'\nresources:\n  values:\n    OWNER: original\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n',
      "slot.ts": 'export default function () { return { SLOT: "one" }; }'
    });
    runMonke({ args: ["spawn", "feature"], cwd: root, monkeHome: home });
    const cwd = getExpectedWorktreePath(home, root, "feature");
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    run("resources", "acquire");
    write(root, "monke.yml", "apps: {}\n");
    run("resources", "acquire");
    expect(read(cwd, ".env")).toContain("SLOT=one");
    expect(read(cwd, ".env")).toContain("OWNER=original");
    run("resources", "release");
    expect(read(cwd, "released")).toBe("done\n");
  });

  test("new acquisition uses current cleanup after release", () => {
    const sandbox = makeTempDir("resource-new-cleanup");
    const home = path.join(sandbox, "home");
    const config = (label: string) =>
      `apps: {}\ncleanupCommand: echo ${label} >> released\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n`;
    const root = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\nreleased\n",
      "monke.yml": config("old"),
      "slot.ts": 'export default function () { return { SLOT: "one" }; }'
    });
    runMonke({ args: ["spawn", "feature"], cwd: root, monkeHome: home });
    const cwd = getExpectedWorktreePath(home, root, "feature");
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    run("resources", "acquire");
    run("resources", "release");
    write(root, "monke.yml", config("new"));
    run("resources", "acquire");
    run("resources", "release");
    expect(read(cwd, "released")).toBe("old\nnew\n");
  });
});
