import { ok } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vite-plus/test";

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
    version: 3
  });
  for (const slug of slugs) {
    write(root, `skills/imported/${slug}/SKILL.md`, `Guidance for ${slug}.`);
  }
}

describe("skill update summaries", () => {
  test("summarizes added, removed, and supporting-file changes in a read-only run", async () => {
    const root = makeTempDir("skill-summary");
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    snapshot(before, ["alpha", "unchanged", "removed"]);
    snapshot(after, ["alpha", "unchanged", "added"]);
    write(before, "skills/imported/alpha/reference.md", "Old guidance.");
    write(after, "skills/imported/alpha/reference.md", "New guidance.");
    const runtime = createTestRuntime({ cwd: root });
    const exec = vi.fn<typeof runtime.execAsync>(async (_command, args = []) => {
      const output = args[args.indexOf("--output-last-message") + 1];
      ok(output);
      writeFileSync(output, "# Skill update summary\n\n## alpha\n\nUpdated reference.");
      return { exitCode: 0, stderr: "", stdout: "" };
    });
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
    expect(exec).toHaveBeenCalledOnce();
    const [call] = exec.mock.calls;
    ok(call);
    const [command, args, options] = call;
    expect(command).toBe("codex");
    expect(args).toContain("--ephemeral");
    expect(args?.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toStrictEqual([
      "--sandbox",
      "read-only"
    ]);
    expect(options?.stdin).toContain("skills/imported/alpha");
    expect(options?.stdin).toContain("skills/imported/added");
    expect(options?.stdin).toContain("skills/imported/removed");
    expect(options?.stdin).not.toContain("skills/imported/unchanged");
    expect(read(after, SKILL_SUMMARY_FILE)).toContain("Updated reference.");
    expect(messages.join("")).toContain("Updated reference.");
  });

  test("removes a partial summary after Codex fails and keeps the updated guidance", async () => {
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

  test("skips Codex when no skill content changed", async () => {
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
