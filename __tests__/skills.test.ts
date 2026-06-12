import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { reconcileSkillNamespaces, resolveSkillInstallTargets } from "../src/skills.ts";
import { makeTempDir, write } from "./helpers.ts";

test("skill install targets resolve built-ins against OS home and normalize custom skill roots", () => {
  const homeDirectory = makeTempDir("skill-target-home");
  const monkeHome = makeTempDir("skill-target-monke-home");

  const targets = resolveSkillInstallTargets({
    homeDirectory,
    preference: {
      targets: [
        { kind: "codex" },
        { kind: "claude" },
        { kind: "cursor" },
        { kind: "custom", path: path.join(homeDirectory, "team-skills") },
      ],
    },
  });

  expect(targets.map((target) => target.agentSkillRoot)).toEqual([
    path.join(homeDirectory, ".codex", "skills"),
    path.join(homeDirectory, ".claude", "skills"),
    path.join(homeDirectory, ".cursor", "skills"),
    path.join(homeDirectory, "team-skills"),
  ]);
  expect(targets.map((target) => target.agentSkillRoot)).not.toContain(monkeHome);
});

test("custom skill roots reject the managed namespace path itself", () => {
  const homeDirectory = makeTempDir("skill-target-custom-invalid");

  expect(() =>
    resolveSkillInstallTargets({
      homeDirectory,
      preference: {
        targets: [{ kind: "custom", path: path.join(homeDirectory, "skills", "monke-tools") }],
      },
    }),
  ).toThrow(/Agent skill root/);
});

test("skill namespace reconciliation creates missing roots and links the namespace to the source tree", () => {
  const sandbox = makeTempDir("skill-reconcile-create");
  const sourceCheckout = path.join(sandbox, "source");
  const agentSkillRoot = path.join(sandbox, "agent", "skills");
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n",
  );

  reconcileSkillNamespaces({
    sourceCheckout,
    previousPreference: null,
    nextPreference: {
      targets: [{ kind: "custom", path: agentSkillRoot }],
    },
    homeDirectory: sandbox,
    writeMessage() {},
  });

  const namespacePath = path.join(agentSkillRoot, "monke-tools");
  expect(existsSync(agentSkillRoot)).toBe(true);
  expect(lstatSync(namespacePath).isSymbolicLink()).toBe(true);
  expect(readlinkSync(namespacePath)).toBe(path.join(sourceCheckout, "skills"));
});

test("Claude skill reconciliation flattens source categories into the Agent skill root", () => {
  const sandbox = makeTempDir("skill-reconcile-claude-flat");
  const sourceCheckout = path.join(sandbox, "source");
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n",
  );
  write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");

  reconcileSkillNamespaces({
    sourceCheckout,
    previousPreference: null,
    nextPreference: {
      targets: [{ kind: "claude" }],
    },
    homeDirectory: sandbox,
    writeMessage() {},
  });

  const claudeSkillRoot = path.join(sandbox, ".claude", "skills");
  const manifestPath = path.join(claudeSkillRoot, ".monke-tools-flat-skills.json");
  const coreLink = path.join(claudeSkillRoot, "monke-tools-core");
  const tddLink = path.join(claudeSkillRoot, "tdd");
  expect(JSON.parse(readFileSync(manifestPath, "utf8")).links).toEqual([
    {
      name: "monke-tools-core",
      sourcePath: path.join(sourceCheckout, "skills", "internal", "monke-tools-core"),
    },
    {
      name: "tdd",
      sourcePath: path.join(sourceCheckout, "skills", "imported", "tdd"),
    },
  ]);
  expect(lstatSync(coreLink).isSymbolicLink()).toBe(true);
  expect(readlinkSync(coreLink)).toBe(
    path.join(sourceCheckout, "skills", "internal", "monke-tools-core"),
  );
  expect(lstatSync(tddLink).isSymbolicLink()).toBe(true);
  expect(readlinkSync(tddLink)).toBe(path.join(sourceCheckout, "skills", "imported", "tdd"));
  expect(existsSync(path.join(claudeSkillRoot, "monke-tools"))).toBe(false);

  reconcileSkillNamespaces({
    sourceCheckout,
    previousPreference: {
      targets: [{ kind: "claude" }],
    },
    nextPreference: {
      targets: [{ kind: "codex" }],
    },
    homeDirectory: sandbox,
    writeMessage() {},
  });

  expect(existsSync(coreLink)).toBe(false);
  expect(existsSync(tddLink)).toBe(false);
  expect(existsSync(manifestPath)).toBe(false);
  expect(lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isSymbolicLink()).toBe(
    true,
  );
});

test("skill namespace reconciliation attempts every selected target before failing on unmanaged namespaces", () => {
  const sandbox = makeTempDir("skill-reconcile-partial");
  const sourceCheckout = path.join(sandbox, "source");
  const blockedSkillRoot = path.join(sandbox, "blocked", "skills");
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n",
  );
  mkdirSync(path.join(blockedSkillRoot, "monke-tools"), { recursive: true });

  expect(() =>
    reconcileSkillNamespaces({
      sourceCheckout,
      previousPreference: null,
      nextPreference: {
        targets: [{ kind: "codex" }, { kind: "custom", path: blockedSkillRoot }],
      },
      homeDirectory: sandbox,
      writeMessage() {},
    }),
  ).toThrow(/Failed to reconcile 1 Skill install target/);

  const codexNamespace = path.join(sandbox, ".codex", "skills", "monke-tools");
  expect(lstatSync(codexNamespace).isSymbolicLink()).toBe(true);
  expect(lstatSync(path.join(blockedSkillRoot, "monke-tools")).isDirectory()).toBe(true);
});

test("skill namespace reconciliation continues after deselected target cleanup failures", () => {
  const sandbox = makeTempDir("skill-reconcile-cleanup-partial");
  const sourceCheckout = path.join(sandbox, "source");
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n",
  );
  write(path.join(sandbox, ".claude", "skills"), ".monke-tools-flat-skills.json", "{}");

  expect(() =>
    reconcileSkillNamespaces({
      sourceCheckout,
      previousPreference: {
        targets: [{ kind: "claude" }],
      },
      nextPreference: {
        targets: [{ kind: "codex" }],
      },
      homeDirectory: sandbox,
      writeMessage() {},
    }),
  ).toThrow(/Failed to reconcile 1 Skill install target/);

  expect(lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isSymbolicLink()).toBe(
    true,
  );
});

test("skill namespace reconciliation removes deselected managed namespaces", () => {
  const sandbox = makeTempDir("skill-reconcile-deselect");
  const sourceCheckout = path.join(sandbox, "source");
  const oldSkillRoot = path.join(sandbox, "old", "skills");
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n",
  );
  mkdirSync(oldSkillRoot, { recursive: true });
  symlinkSync(path.join(sourceCheckout, "skills"), path.join(oldSkillRoot, "monke-tools"), "dir");

  reconcileSkillNamespaces({
    sourceCheckout,
    previousPreference: {
      targets: [{ kind: "custom", path: oldSkillRoot }],
    },
    nextPreference: {
      targets: [{ kind: "codex" }],
    },
    homeDirectory: sandbox,
    writeMessage() {},
  });

  expect(existsSync(path.join(oldSkillRoot, "monke-tools"))).toBe(false);
  expect(lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isSymbolicLink()).toBe(
    true,
  );
});
