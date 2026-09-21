import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createRepo, makeTempDir, read, runMonke, spawnMonkeWorker, write } from "./helpers.ts";

describe("checkout resources", () => {
  test("a source checkout acquires once and exec uses recorded values without exporting them to dotenv", () => {
    const sandbox = makeTempDir("checkout-resources");
    const home = path.join(sandbox, "home");
    const cwd = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\ncount\nobserved\n",
      "consume.ts": 'await Bun.write("observed", process.env.SLOT + ":" + process.env.CONFIG);',
      "monke.yml":
        "apps: {}\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n",
      "slot.ts": `export async function acquire() {
      const file = Bun.file("count");
      await Bun.write("count", String(await file.exists() ? Number(await file.text()) + 1 : 1));
      return { SLOT: "owned" };
    }
    export async function release({ outputs }) { if (outputs.SLOT !== "owned") throw new Error("wrong owner"); }`
    });
    const run = (...args: string[]) =>
      runMonke({ args, cwd, extraEnv: { SLOT: "inherited" }, monkeHome: home });
    write(cwd, ".env", "SLOT=stale\nCONFIG=normal\n");
    expect(() => run("resources", "exec", "--", "bun", "consume.ts")).toThrow(/acquire/u);
    expect(existsSync(path.join(cwd, "observed"))).toBeFalsy();
    run("resources", "acquire");
    run("resources", "acquire");
    expect(read(cwd, "count")).toBe("1");
    expect(read(cwd, ".env")).not.toContain("SLOT=");
    run("resources", "exec", "--", "bun", "consume.ts");
    expect(read(cwd, "observed")).toBe("owned:normal");
    run("resources", "release");
    expect(() => run("resources", "exec", "--", "bun", "consume.ts")).toThrow(/acquire/u);
  });

  test("setup establishes source infrastructure identity before live acquisition", () => {
    const sandbox = makeTempDir("checkout-resource-static-setup");
    const home = path.join(sandbox, "home");
    const cwd = createRepo(path.join(sandbox, "repo"), {
      "live.ts":
        'export async function acquire() { await Bun.write("acquired", "yes"); return {LIVE: "allocated"}; }',
      "monke.yml":
        // oxlint-disable-next-line no-template-curly-in-string -- MT interpolates this YAML literal.
        "apps: {}\nresources:\n  values:\n    COMPOSE_PROJECT_NAME: project-${id}\n  commands:\n    live:\n      acquire: explicit\n      run: live.ts\n      outputs: [LIVE]\n"
    });
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    run("setup");
    const staticEnv = read(cwd, ".env");
    expect(staticEnv).toMatch(/COMPOSE_PROJECT_NAME=project-[a-f0-9]{32}/u);
    expect(existsSync(path.join(cwd, "acquired"))).toBeFalsy();
    expect(() => run("resources", "exec", "--", "true")).toThrow(/acquire/u);
    run("resources", "acquire");
    expect(read(cwd, ".env")).toBe(staticEnv);
    expect(read(cwd, "acquired")).toBe("yes");
  });

  test("source and Session allocations share collision protection and chop releases before teardown", () => {
    const sandbox = makeTempDir("checkout-resource-sessions");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\norder\n",
      "monke.yml":
        "apps: {}\nbootstrapCommand: 'true'\ncleanupCommand: 'echo infra >> \"$MONKE_SOURCE_ROOT/order\"'\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n",
      "slot.ts": `export function acquire({previous}) { let n = 1; while (previous.SLOT.includes(String(n))) n++; return {SLOT: String(n)}; }
    export async function release({owner, outputs}) { const file = owner.sourceRoot + "/order"; const old = await Bun.file(file).exists() ? await Bun.file(file).text() : ""; await Bun.write(file, old + "release:" + outputs.SLOT + "\\n"); }`
    });
    const invoke = (cwd: string, ...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    invoke(root, "resources", "acquire");
    invoke(root, "spawn", "feature");
    const checkout = path.join(home, "worktrees", "repo", "feature");
    invoke(checkout, "resources", "acquire");
    expect(
      invoke(checkout, "resources", "exec", "--", "sh", "-c", 'printf %s "$SLOT"').stdout
    ).toBe("2");
    invoke(checkout, "resources", "release");
    expect(read(root, "order")).toBe("release:2\n");
    invoke(checkout, "resources", "acquire");
    invoke(root, "chop", "feature");
    expect(existsSync(checkout)).toBeFalsy();
    expect(read(root, "order")).toBe("release:2\nrelease:2\ninfra\n");
    expect(invoke(root, "resources", "exec", "--", "sh", "-c", 'printf %s "$SLOT"').stdout).toBe(
      "1"
    );
  });

  test("partial acquisition is resumable and release checkpoints each successful resource", () => {
    const sandbox = makeTempDir("checkout-resource-retry");
    const home = path.join(sandbox, "home");
    const cwd = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\nready\nrelease-ready\nevents\n",
      "first.ts": `import {appendFileSync} from "node:fs";
      export function acquire() { appendFileSync("events", "acquire:first\\n"); return {FIRST: "one"}; }
      export async function release({outputs}) { if (outputs.FIRST !== "one") throw new Error("wrong target"); if (!await Bun.file("release-ready").exists()) throw new Error("release unavailable"); appendFileSync("events", "release:first\\n"); }`,
      "monke.yml":
        "apps: {}\nresources:\n  commands:\n    first:\n      acquire: explicit\n      run: first.ts\n      outputs: [FIRST]\n    second:\n      acquire: explicit\n      run: second.ts\n      outputs: [SECOND]\n",
      "second.ts": `import {appendFileSync} from "node:fs";
      export async function acquire() { if (!await Bun.file("ready").exists()) throw new Error("not ready"); appendFileSync("events", "acquire:second\\n"); return {SECOND: "two"}; }
      export function release({outputs}) { if (outputs.SECOND !== "two") throw new Error("wrong target"); appendFileSync("events", "release:second\\n"); }`
    });
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    expect(() => run("resources", "acquire")).toThrow(/not ready/u);
    expect(() => run("resources", "exec", "--", "true")).toThrow(/second/u);
    write(cwd, "ready", "yes");
    run("resources", "acquire");
    expect(() => run("resources", "release")).toThrow(/release unavailable/u);
    expect(() => run("resources", "exec", "--", "true")).toThrow(/second/u);
    write(cwd, "release-ready", "yes");
    run("resources", "release");
    run("resources", "release");
    expect(read(cwd, "events")).toBe(
      "acquire:first\nacquire:second\nrelease:second\nrelease:first\n"
    );
  });

  test("config changes retain the original release payload and cannot replace an allocation", () => {
    const sandbox = makeTempDir("checkout-resource-config-drift");
    const home = path.join(sandbox, "home");
    const config = (outputs: string) =>
      `apps: {}\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [${outputs}]\n`;
    const cwd = createRepo(path.join(sandbox, "repo"), {
      "monke.yml": config("SLOT, AUX"),
      "slot.ts": `export function acquire() { return {SLOT: "one", AUX: "two"}; }
      export async function release({outputs}) { await Bun.write("released", JSON.stringify(outputs)); }`
    });
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    run("resources", "acquire");
    write(cwd, "monke.yml", config("SLOT"));
    run("resources", "acquire");
    write(cwd, "monke.yml", config("SLOT, NEW"));
    expect(() => run("resources", "acquire")).toThrow(/release/u);
    rmSync(path.join(cwd, "monke.yml"));
    run("resources", "release");
    expect(JSON.parse(read(cwd, "released"))).toStrictEqual({ AUX: "two", SLOT: "one" });
  });

  test("exec uses current declarations while retaining retired outputs for release", () => {
    const sandbox = makeTempDir("checkout-resource-replacement");
    const home = path.join(sandbox, "home");
    const config = (name: string) =>
      `apps: {}\nresources:\n  commands:\n    ${name}:\n      run: ${name}.ts\n      outputs: [SLOT]\n`;
    const cwd = createRepo(path.join(sandbox, "repo"), {
      "current.ts": 'export function acquire() { return {SLOT: "current"}; }',
      "monke.yml": config("old"),
      "old.ts": 'export function acquire() { return {SLOT: "old"}; }'
    });
    const run = (...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    run("resources", "acquire");
    write(cwd, "monke.yml", config("current"));
    run("resources", "acquire");
    expect(run("resources", "exec", "--", "printenv", "SLOT").stdout.trim()).toBe("current");
  });

  test("terminating exec stops a shell's waiting descendants before releasing resources", async () => {
    const sandbox = makeTempDir("checkout-resource-shell-signal");
    const home = path.join(sandbox, "home");
    const cwd = createRepo(path.join(sandbox, "repo"), {
      "monke.yml": "apps: {}\n",
      "wait.ts":
        'process.on("SIGTERM", () => {}); await Bun.write("started", String(process.pid)); await new Promise(() => {});'
    });
    const child = spawnMonkeWorker({
      args: ["resources", "exec", "--", "sh", "-c", "bun wait.ts & wait"],
      cwd,
      monkeHome: home
    });
    let pid: number | undefined;
    const alive = () => {
      if (pid === undefined) {
        return false;
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await expect.poll(() => existsSync(path.join(cwd, "started"))).toBe(true);
      pid = Number(read(cwd, "started"));
      child.kill("SIGTERM");
      await child.exited;
      await expect.poll(alive).toBe(false);
      runMonke({ args: ["resources", "release"], cwd, monkeHome: home });
    } finally {
      if (alive() && pid !== undefined) {
        process.kill(pid, "SIGKILL");
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });

  test("an active exec blocks release and chop but leaves other checkouts usable", async () => {
    const sandbox = makeTempDir("checkout-resource-use");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": ".env\nstarted\nfinish\nreleased\n",
      "monke.yml":
        "apps: {}\nresources:\n  commands:\n    slot:\n      acquire: explicit\n      run: slot.ts\n      outputs: [SLOT]\n",
      "slot.ts":
        'export function acquire({previous}) { return {SLOT: previous.SLOT.includes("one") ? "two" : "one"}; } export async function release() { await Bun.write("released", "yes"); }',
      "wait.ts":
        'await Bun.write("started", "yes"); while (!await Bun.file("finish").exists()) await Bun.sleep(20);'
    });
    const invoke = (cwd: string, ...args: string[]) => runMonke({ args, cwd, monkeHome: home });
    invoke(root, "resources", "acquire");
    invoke(root, "spawn", "feature");
    const cwd = path.join(home, "worktrees", "repo", "feature");
    invoke(cwd, "resources", "acquire");
    const child = spawnMonkeWorker({
      args: ["resources", "exec", "--", "bun", "wait.ts"],
      cwd,
      monkeHome: home
    });
    try {
      await expect.poll(() => existsSync(path.join(cwd, "started"))).toBe(true);
      expect(() => invoke(cwd, "resources", "release")).toThrow(/in use/u);
      expect(() => invoke(root, "chop", "feature", "--force")).toThrow(/in use/u);
      expect(existsSync(path.join(cwd, "released"))).toBeFalsy();
      expect(invoke(root, "resources", "exec", "--", "sh", "-c", 'printf %s "$SLOT"').stdout).toBe(
        "one"
      );
    } finally {
      write(cwd, "finish", "yes");
      await child.exited;
    }
    invoke(cwd, "resources", "release");
    expect(read(cwd, "released")).toBe("yes");
  });

  test("exec preserves the child exit code and forwards output", async () => {
    const sandbox = makeTempDir("checkout-resource-exit");
    const cwd = createRepo(path.join(sandbox, "repo"), { "monke.yml": "apps: {}\n" });
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/index.ts", import.meta.url).pathname,
        "resources",
        "exec",
        "--",
        "sh",
        "-c",
        "echo output; echo diagnostic >&2; exit 23"
      ],
      {
        cwd,
        env: { ...process.env, MONKE_HOME: path.join(sandbox, "home") },
        stderr: "pipe",
        stdout: "pipe"
      }
    );
    await expect(child.exited).resolves.toBe(23);
    await expect(new Response(child.stdout).text()).resolves.toBe("output\n");
    await expect(new Response(child.stderr).text()).resolves.toBe("diagnostic\n");
  });

  test("exec forwards termination and keeps surviving children protected if the wrapper is killed", async () => {
    const sandbox = makeTempDir("checkout-resource-signals");
    const home = path.join(sandbox, "home");
    const cwd = createRepo(path.join(sandbox, "repo"), {
      ".gitignore": "started\nterminated\n",
      "monke.yml": "apps: {}\n",
      "wait.ts":
        'process.on("SIGTERM", () => { require("node:fs").writeFileSync("terminated", "yes"); process.exit(0); }); await Bun.write("started", String(process.pid)); await new Promise(() => {});'
    });
    const args = [
      process.execPath,
      new URL("../src/index.ts", import.meta.url).pathname,
      "resources",
      "exec",
      "--",
      "bun",
      "wait.ts"
    ];
    const child = Bun.spawn(args, {
      cwd,
      env: { ...process.env, MONKE_HOME: home },
      stderr: "ignore",
      stdout: "ignore"
    });
    try {
      await expect.poll(() => existsSync(path.join(cwd, "started"))).toBe(true);
      child.kill("SIGTERM");
      await child.exited;
      expect(read(cwd, "terminated")).toBe("yes");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    rmSync(path.join(cwd, "started"));
    const wrapper = Bun.spawn(args, {
      cwd,
      env: { ...process.env, MONKE_HOME: home },
      stderr: "ignore",
      stdout: "ignore"
    });
    let pid: number | undefined;
    try {
      await expect.poll(() => existsSync(path.join(cwd, "started"))).toBe(true);
      pid = Number(read(cwd, "started"));
      wrapper.kill("SIGKILL");
      await wrapper.exited;
      expect(() => runMonke({ args: ["resources", "release"], cwd, monkeHome: home })).toThrow(
        /in use/u
      );
    } finally {
      if (pid !== undefined) {
        process.kill(pid, "SIGKILL");
      }
      if (wrapper.exitCode === null) {
        wrapper.kill("SIGKILL");
        await wrapper.exited;
      }
    }
  });
});
