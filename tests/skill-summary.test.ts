import { ok } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { SKILL_SUMMARY_FILE, summarizeSkillChanges } from "../scripts/skill-summary.ts";
import { makeTempDir, read, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function snapshot(root: string, slugs: string[]) {
  writeImportRecipeStore(root, {
    recipes: slugs.length
      ? [
          {
            skills: slugs.map((slug) => ({ kind: "skill", selector: slug, slug })),
            source: "owner/repo"
          }
        ]
      : [],
    version: 4
  });

  for (const slug of slugs) {
    write(root, `skills/imported/${slug}/SKILL.md`, `Guidance for ${slug}.`);
  }
}

function respond(args: string[] | undefined, summary: string) {
  const output = args?.[args.indexOf("--output-last-message") + 1];
  ok(output);
  writeFileSync(output, summary);

  return { exitCode: 0, stderr: "", stdout: "" };
}

describe("skill update summaries", () => {
  it("summarizes added, removed, and supporting-file changes in a read-only run", async () => {
    const root = makeTempDir("skill-summary");
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    snapshot(before, ["alpha", "unchanged", "removed"]);
    snapshot(after, ["alpha", "unchanged", "added"]);
    write(before, "skills/imported/alpha/reference.md", "Old guidance.");
    write(after, "skills/imported/alpha/reference.md", "New guidance.");
    const runtime = createTestRuntime({ cwd: root });

    const exec = vi.fn<typeof runtime.execAsync>(async (_command, args, options) =>
      respond(
        args,
        `- Updated ${options?.stdin?.match(/imported skill (?<slug>[\w-]+)\./u)?.groups?.slug}.`
      )
    );

    runtime.execAsync = exec;
    const messages: string[] = [];
    await summarizeSkillChanges({
      after,
      before,
      runtime,
      writeMessage: (message) => {
        messages.push(message);
      }
    });
    expect(exec).toHaveBeenCalledTimes(3);

    const prompts = exec.mock.calls.map(([command, args, options]) => {
      expect(command).toBe("codex");
      expect(args).toContain("--ephemeral");
      expect(args?.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toStrictEqual([
        "--sandbox",
        "read-only"
      ]);

      return options?.stdin ?? "";
    });

    const alpha = prompts.find((prompt) => prompt.includes("skill alpha."));
    expect(alpha).toContain(path.join(before, "skills/imported/alpha"));
    expect(alpha).toContain(path.join(after, "skills/imported/alpha"));
    expect(prompts.find((prompt) => prompt.includes("skill added."))).toContain(
      "Before: absent; the skill was added"
    );
    expect(prompts.find((prompt) => prompt.includes("skill removed."))).toContain(
      "After: absent; the skill was removed"
    );
    expect(prompts.join("")).not.toContain("unchanged");
    expect(read(after, SKILL_SUMMARY_FILE)).toBe(
      "# Skill update summary\n\n## alpha\n\n- Updated alpha.\n\n## removed\n\n- Updated removed.\n\n## added\n\n- Updated added.\n"
    );
    expect(messages.join("")).toContain("## alpha\n\n- Updated alpha.");
  });

  it("summarizes a change shared by collections once and labels distinct checkout changes", async () => {
    const root = makeTempDir("skill-summary-shared");
    const before = path.join(root, "before");
    const after = path.join(root, "after");

    for (const collection of ["", "repositories/publisher"]) {
      snapshot(path.join(before, collection), ["shared", "own"]);
      snapshot(path.join(after, collection), ["shared", "own"]);
      write(after, path.join(collection, "skills/imported/shared/SKILL.md"), "Shared update.");
    }

    write(after, "skills/imported/own/SKILL.md", "Consumer update.");
    write(after, "repositories/publisher/skills/imported/own/SKILL.md", "Publisher update.");
    const runtime = createTestRuntime({ cwd: root });
    let running = 0;
    let overlapped = false;

    const exec = vi.fn<typeof runtime.execAsync>(async (_command, args) => {
      running += 1;
      overlapped ||= running > 1;
      await Bun.sleep(20);
      running -= 1;

      return respond(args, "- Changed.");
    });

    runtime.execAsync = exec;

    await summarizeSkillChanges({
      after,
      before,
      collections: ["repositories/publisher"],
      runtime,
      writeMessage() {}
    });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(overlapped).toBeTruthy();
    expect(read(after, SKILL_SUMMARY_FILE)).toBe(
      "# Skill update summary\n\n## own\n\n- Changed.\n\n## shared\n\n- Changed.\n\n## own in publisher\n\n- Changed.\n"
    );
  });

  it("keeps successful skill summaries when another skill's summary times out", async () => {
    const root = makeTempDir("skill-summary-partial");
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    snapshot(before, []);
    snapshot(after, ["fast", "slow"]);
    const runtime = createTestRuntime({ cwd: root });

    runtime.execAsync = async (_command, args, options) =>
      options?.stdin?.includes("skill slow.")
        ? { exitCode: 1, stderr: "", stdout: "", timedOut: true }
        : respond(args, "- Added fast guidance.");

    await summarizeSkillChanges({ after, before, runtime, writeMessage() {} });
    expect(read(after, SKILL_SUMMARY_FILE)).toBe(
      "# Skill update summary\n\n## fast\n\n- Added fast guidance.\n\n## slow\n\nSummary unavailable: Codex timed out\n"
    );
  });

  it("removes a partial summary after Codex fails and keeps the updated guidance", async () => {
    const root = makeTempDir("skill-summary-failure");
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    snapshot(before, []);
    snapshot(after, ["alpha"]);
    const runtime = createTestRuntime({ cwd: root });
    runtime.execAsync = async (_command, args = []) => {
      const output = args[args.indexOf("--output-last-message") + 1];
      ok(output);
      writeFileSync(output, "Partial output");

      return { exitCode: 1, stderr: "Unavailable", stdout: "" };
    };

    let messages = "";
    await summarizeSkillChanges({
      after,
      before,
      runtime,
      writeMessage: (message) => {
        messages += message;
      }
    });
    expect(messages).toContain("Skill update summary unavailable: Unavailable");
    expect(existsSync(path.join(after, SKILL_SUMMARY_FILE))).toBeFalsy();
    expect(read(after, "skills/imported/alpha/SKILL.md")).toBe("Guidance for alpha.");
  });

  it("skips Codex when no skill content changed", async () => {
    const root = makeTempDir("skill-summary-unchanged");
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    snapshot(before, ["alpha"]);
    snapshot(after, ["alpha"]);
    const runtime = createTestRuntime({ cwd: root });
    const exec = vi.fn<typeof runtime.execAsync>();
    runtime.execAsync = exec;
    await summarizeSkillChanges({ after, before, runtime, writeMessage() {} });
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(path.join(after, SKILL_SUMMARY_FILE))).toBeFalsy();
  });
});
