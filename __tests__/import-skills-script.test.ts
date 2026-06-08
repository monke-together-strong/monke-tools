import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { expect, test } from "vitest";

import {
  buildGroupedSkillOptions,
  copyStagedSkillsToImported,
  extractSecurityRiskAssessment,
  normalizeSourceForStaging,
  parseAvailableSkillGroups,
  parseAvailableSkillNames,
  runImportSkills,
} from "../scripts/import-skills.ts";
import { makeTempDir, read, write } from "./helpers.ts";

test("parseAvailableSkillGroups preserves group headings from skills list output", () => {
  const output = [
    "\u001b[?25l\u2502",
    "\u25c7  Available Skills",
    "\u2502",
    "Engineering",
    "\u2502",
    "\u2502    alpha-skill",
    "\u2502",
    "\u2502      Alpha skill description.",
    "Personal Tools",
    "\u2502",
    "\u2502    Bravo Skill",
    "\u2502",
    "\u2502      Bravo skill description.",
    "\u2502",
    "\u2514  Use --skill <name> to install specific skills",
  ].join("\n");

  expect(parseAvailableSkillGroups(output)).toEqual([
    {
      name: "Engineering",
      skills: ["alpha-skill"],
    },
    {
      name: "Personal Tools",
      skills: ["Bravo Skill"],
    },
  ]);
  expect(parseAvailableSkillNames(output)).toEqual(["alpha-skill", "Bravo Skill"]);
});

test("buildGroupedSkillOptions keeps Clack group labels separate from skill values", () => {
  expect(
    buildGroupedSkillOptions([
      {
        name: "Engineering",
        skills: ["alpha", "bravo"],
      },
      {
        name: "Writing",
        skills: ["charlie"],
      },
    ]),
  ).toEqual({
    Engineering: [
      {
        value: "alpha",
        label: "alpha",
      },
      {
        value: "bravo",
        label: "bravo",
      },
    ],
    Writing: [
      {
        value: "charlie",
        label: "charlie",
      },
    ],
  });
});

test("parseAvailableSkillNames fails when skills list output is unrecognized", () => {
  expect(() => parseAvailableSkillNames("No skills here")).toThrow(/Could not parse/);
});

test("extractSecurityRiskAssessment filters upstream install output down to security details", () => {
  const output = [
    "\u25c7  Installation Summary",
    "\u2502  ./.agents/skills/alpha",
    "\u25c7  Security Risk Assessments",
    "\u2502  alpha  Safe  0 alerts  Low Risk",
    "\u2502  Details: https://skills.sh/owner/repo",
    "\u251c\u2500\u2500\u2500\u256f",
    "\u2502",
    "\u25c7  Installation complete",
    "\u25c7  Installed 1 skill",
    "\u2502  \u2192 ./.agents/skills/alpha",
  ].join("\n");

  const assessment = extractSecurityRiskAssessment(output);
  const plainAssessment = stripAnsiForTest(assessment ?? "");

  expect(plainAssessment).toContain("Security Risk Assessments");
  expect(plainAssessment).toContain("alpha");
  expect(plainAssessment).toContain("Safe");
  expect(plainAssessment).toContain("0 alerts");
  expect(plainAssessment).toContain("Low Risk");
  expect(plainAssessment).toContain("Details: https://skills.sh/owner/repo");
  expect(assessment).toContain(pc.cyan("alpha"));
  expect(assessment).toContain(pc.green("Safe"));
  expect(assessment).toContain(pc.green("0 alerts"));
  expect(assessment).toContain(pc.green("Low Risk"));
  expect(assessment).not.toContain("Installation Summary");
  expect(assessment).not.toContain("Installed 1 skill");
  expect(assessment).not.toContain(".agents/skills");
});

test("normalizeSourceForStaging resolves local paths before running in temp staging", () => {
  const cwd = makeTempDir("skill-import-source-cwd");

  expect(normalizeSourceForStaging("./skills-source", cwd)).toBe(path.join(cwd, "skills-source"));
  expect(normalizeSourceForStaging("vercel-labs/skills", cwd)).toBe("vercel-labs/skills");
});

test("copyStagedSkillsToImported overwrites imported skills and preserves staged directory names", () => {
  const sandbox = makeTempDir("skill-import-copy");
  const stagingDirectory = path.join(sandbox, "staging");
  write(stagingDirectory, ".agents/skills/alpha-skill/SKILL.md", "new alpha");
  write(stagingDirectory, ".agents/skills/bravo-skill/SKILL.md", "new bravo");
  write(sandbox, "skills/imported/alpha-skill/SKILL.md", "old alpha");

  const imported = copyStagedSkillsToImported({
    stagingDirectory,
    repoRoot: sandbox,
  });

  expect(imported.sort()).toEqual(["alpha-skill", "bravo-skill"]);
  expect(read(sandbox, "skills/imported/alpha-skill/SKILL.md")).toBe("new alpha");
  expect(read(sandbox, "skills/imported/bravo-skill/SKILL.md")).toBe("new bravo");
});

test("skills import script wraps npx skills and copies staged universal skills", async () => {
  const sandbox = makeTempDir("skill-import-script");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  let stdout = "";
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runImportSkills(["owner/repo"], {
      async selectSkills(availableSkillGroups) {
        expect(availableSkillGroups).toEqual([
          {
            name: "Engineering",
            skills: ["alpha"],
          },
          {
            name: "Productivity",
            skills: ["bravo"],
          },
        ]);
        return ["alpha", "bravo"];
      },
      writeMessage(message) {
        stdout += message;
      },
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  const plainStdout = stripAnsiForTest(stdout);
  expect(plainStdout).toContain("Security Risk Assessments");
  expect(plainStdout).toContain("alpha");
  expect(plainStdout).toContain("Safe");
  expect(plainStdout).toContain("0 alerts");
  expect(plainStdout).toContain("Low Risk");
  expect(stdout).toContain(pc.cyan("alpha"));
  expect(stdout).toContain(pc.green("Safe"));
  expect(stdout).not.toContain("Installation Summary");
  expect(stdout).not.toContain("Installed 2 skills");
  expect(stdout).not.toContain(".agents/skills");
  expect(stdout).not.toContain("Imported alpha -> skills/imported/alpha");
  expect(stdout).not.toContain("Imported bravo -> skills/imported/bravo");
  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
  expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
  expect(existsSync(path.join(sandbox, ".agents"))).toBe(false);
  expect(existsSync(path.join(sandbox, "skills-lock.json"))).toBe(false);

  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain("--yes skills add owner/repo -l");
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes",
  );

  const stagingCwds = readFileSync(skillsCwdLogPath, "utf8").trim().split("\n").filter(Boolean);
  expect(stagingCwds).toHaveLength(2);
  expect(stagingCwds.every((cwd) => cwd !== sandbox)).toBe(true);
  expect(stagingCwds.every((cwd) => !existsSync(cwd))).toBe(true);
});

test("skills import script can run local skill install after importing with -i", async () => {
  const sandbox = makeTempDir("skill-import-script-install");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const installCalls: string[] = [];
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runImportSkills(["owner/repo", "-i"], {
      async selectSkills() {
        return ["alpha"];
      },
      runInstallCommand(repoRoot) {
        installCalls.push(repoRoot);
        expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
      },
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(installCalls).toEqual([sandbox]);
});

function installFakeNpx(
  sandbox: string,
  options: { skillsLogPath: string; skillsCwdLogPath: string },
): string {
  const binDirectory = path.join(sandbox, "fake-bin");
  mkdirSync(binDirectory, { recursive: true });
  const scriptPath = path.join(binDirectory, "npx");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$PWD" >> '${options.skillsCwdLogPath}'
for arg in "$@"; do
  printf '%s ' "$arg" >> '${options.skillsLogPath}'
done
printf '\\n' >> '${options.skillsLogPath}'

is_list=0
for arg in "$@"; do
  if [ "$arg" = "-l" ]; then
    is_list=1
  fi
done

if [ "$is_list" = "1" ]; then
  cat <<'OUT'
\u2502
\u25c7  Available Skills
\u2502
Engineering
\u2502
\u2502    alpha
\u2502
\u2502      Alpha description.
\u2502
Productivity
\u2502
\u2502    bravo
\u2502
\u2502      Bravo description.
\u2502
\u2514  Use --skill <name> to install specific skills
OUT
  exit 0
fi

cat <<'OUT'
Installation Summary
./.agents/skills/alpha
Security Risk Assessments
alpha Safe 0 alerts Low Risk
Details: https://skills.sh/owner/repo
Installation complete
Installed 2 skills
./.agents/skills/alpha
OUT
mkdir -p .agents/skills/alpha .agents/skills/bravo
printf 'new alpha' > .agents/skills/alpha/SKILL.md
printf 'new bravo' > .agents/skills/bravo/SKILL.md
printf '{"version":1}' > skills-lock.json
exit 0
`,
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return binDirectory;
}

function stripAnsiForTest(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "g"), "");
}
