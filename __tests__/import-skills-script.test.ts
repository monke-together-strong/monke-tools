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
  readImportRecipeStore,
  recordImportedSkills,
  runImportSkills,
  writeImportRecipeStore,
} from "../scripts/import-skills.ts";
import { runUpdateSkills } from "../scripts/update-skills.ts";
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

test("skill import recipe store writes sorted deterministic output", () => {
  const sandbox = makeTempDir("skill-import-recipes");

  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "z-owner/z-repo",
        acceptOpenClawRisks: true,
        skills: [
          {
            selector: "bravo",
            slug: "bravo",
          },
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
      {
        source: "a-owner/a-repo",
        skills: [
          {
            selector: "zulu",
            slug: "zulu",
          },
        ],
      },
    ],
  });

  expect(read(sandbox, "skills/imported/.monke-imports.json")).toBe(`{
  "version": 1,
  "recipes": [
    {
      "source": "a-owner/a-repo",
      "skills": [
        {
          "selector": "zulu",
          "slug": "zulu"
        }
      ]
    },
    {
      "source": "z-owner/z-repo",
      "acceptOpenClawRisks": true,
      "skills": [
        {
          "selector": "alpha",
          "slug": "alpha"
        },
        {
          "selector": "bravo",
          "slug": "bravo"
        }
      ]
    }
  ]
}
`);
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "a-owner/a-repo",
        skills: [
          {
            selector: "zulu",
            slug: "zulu",
          },
        ],
      },
      {
        source: "z-owner/z-repo",
        acceptOpenClawRisks: true,
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
          {
            selector: "bravo",
            slug: "bravo",
          },
        ],
      },
    ],
  });
});

test("skill import recipe store rejects duplicate recipe sources", () => {
  const sandbox = makeTempDir("skill-import-recipes-duplicate-source");
  write(
    sandbox,
    "skills/imported/.monke-imports.json",
    JSON.stringify({
      version: 1,
      recipes: [
        {
          source: "owner/repo",
          skills: [
            {
              selector: "alpha",
              slug: "alpha",
            },
          ],
        },
        {
          source: "owner/repo",
          skills: [
            {
              selector: "bravo",
              slug: "bravo",
            },
          ],
        },
      ],
    }),
  );

  expect(() => readImportRecipeStore(sandbox)).toThrow(
    /Duplicate skill import recipe source: owner\/repo/,
  );
});

test("skill import recipe store rejects unknown future versions", () => {
  const sandbox = makeTempDir("skill-import-recipes-future-version");
  write(
    sandbox,
    "skills/imported/.monke-imports.json",
    JSON.stringify({ version: 2, recipes: [] }),
  );

  expect(() => readImportRecipeStore(sandbox)).toThrow(/version must be 1/);
});

test("skill import recipe store rejects duplicate selectors in one recipe", () => {
  const sandbox = makeTempDir("skill-import-recipes-duplicate-selector");
  write(
    sandbox,
    "skills/imported/.monke-imports.json",
    JSON.stringify({
      version: 1,
      recipes: [
        {
          source: "owner/repo",
          skills: [
            {
              selector: "alpha",
              slug: "alpha",
            },
            {
              selector: "alpha",
              slug: "alpha-v2",
            },
          ],
        },
      ],
    }),
  );

  expect(() => readImportRecipeStore(sandbox)).toThrow(
    /Duplicate skill selector in recipe owner\/repo: alpha/,
  );
});

test("skill import recipe store rejects duplicate imported skill owners", () => {
  const sandbox = makeTempDir("skill-import-recipes-duplicate-owner");
  write(
    sandbox,
    "skills/imported/.monke-imports.json",
    JSON.stringify({
      version: 1,
      recipes: [
        {
          source: "owner/first",
          skills: [
            {
              selector: "alpha",
              slug: "alpha",
            },
          ],
        },
        {
          source: "owner/second",
          skills: [
            {
              selector: "other-alpha",
              slug: "alpha",
            },
          ],
        },
      ],
    }),
  );

  expect(() => readImportRecipeStore(sandbox)).toThrow(
    /Imported skill slug alpha is owned by both owner\/first and owner\/second/,
  );
});

test("skill import recipe recording rejects duplicate imported skill owners", () => {
  const sandbox = makeTempDir("skill-import-recipes-duplicate");
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/first",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });

  expect(() =>
    recordImportedSkills(sandbox, {
      source: "owner/second",
      acceptOpenClawRisks: false,
      skills: [
        {
          selector: "other-alpha",
          slug: "alpha",
        },
      ],
    }),
  ).toThrow(/alpha is already owned by recipe owner\/first/);
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/first",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
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

test("skills import script records selected skills and merges compatible same-source recipes", async () => {
  const sandbox = makeTempDir("skill-import-script-recipes");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runImportSkills(["owner/repo"], {
      async selectSkills() {
        return ["alpha"];
      },
      writeMessage() {},
    });
    await runImportSkills(["owner/repo"], {
      async selectSkills() {
        return ["bravo"];
      },
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
          {
            selector: "bravo",
            slug: "bravo",
          },
        ],
      },
    ],
  });
});

test("skills import script resolves multiple selector slug aliases", async () => {
  const sandbox = makeTempDir("skill-import-script-aliases");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, {
    skillsLogPath,
    skillsCwdLogPath,
    stagedSlugBySelector: {
      alpha: "renamed-alpha",
      bravo: "renamed-bravo",
    },
  });

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runImportSkills(["owner/repo"], {
      async selectSkills() {
        return ["alpha", "bravo"];
      },
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
  expect(read(sandbox, "skills/imported/renamed-bravo/SKILL.md")).toBe("new renamed-bravo");
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "renamed-alpha",
          },
          {
            selector: "bravo",
            slug: "renamed-bravo",
          },
        ],
      },
    ],
  });

  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes",
  );
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill alpha --agent universal --copy --yes",
  );
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill bravo --agent universal --copy --yes",
  );
});

test("skills import script passes and records explicit OpenClaw risk acceptance", async () => {
  const sandbox = makeTempDir("skill-import-openclaw");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runImportSkills(["openclaw/agent-skills", "--accept-openclaw-risks"], {
      async selectSkills() {
        return ["autoreview"];
      },
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain(
    "--yes skills add openclaw/agent-skills --dangerously-accept-openclaw-risks -l",
  );
  expect(skillsLog).toContain(
    "--yes skills add openclaw/agent-skills --dangerously-accept-openclaw-risks --skill autoreview --agent universal --copy --yes",
  );
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "openclaw/agent-skills",
        acceptOpenClawRisks: true,
        skills: [
          {
            selector: "autoreview",
            slug: "autoreview",
          },
        ],
      },
    ],
  });
});

test("skills import script rejects local slug ownership conflicts before copying", async () => {
  const sandbox = makeTempDir("skill-import-script-conflict");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/first",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await expect(
      runImportSkills(["owner/second"], {
        async selectSkills() {
          return ["alpha"];
        },
        writeMessage() {},
      }),
    ).rejects.toThrow(/alpha is already owned by recipe owner\/first/);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/first",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
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

test("skills update reruns recorded recipes without prompting for selection", async () => {
  const sandbox = makeTempDir("skill-update-script");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  let stdout = "";
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
          {
            selector: "bravo",
            slug: "bravo",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
  write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runUpdateSkills([], {
      writeMessage(message) {
        stdout += message;
      },
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
  expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
  expect(stripAnsiForTest(stdout)).toContain("Security Risk Assessments");
  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes",
  );
  expect(skillsLog).not.toContain("-l");
});

test("skills update continues through later recipes after one recipe fails", async () => {
  const sandbox = makeTempDir("skill-update-script-failure");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, {
    skillsLogPath,
    skillsCwdLogPath,
    failInstallSources: ["owner/fails"],
  });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/fails",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
      {
        source: "owner/works",
        skills: [
          {
            selector: "bravo",
            slug: "bravo",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
  write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await expect(
      runUpdateSkills([], {
        writeMessage() {},
      }),
    ).rejects.toThrow(/owner\/fails/);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
  expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain(
    "--yes skills add owner/fails --skill alpha --agent universal --copy --yes",
  );
  expect(skillsLog).toContain(
    "--yes skills add owner/works --skill bravo --agent universal --copy --yes",
  );
});

test("skills update rejects untracked imported skill directories before invoking upstream", async () => {
  const sandbox = makeTempDir("skill-update-script-untracked");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
  write(sandbox, "skills/imported/orphan/SKILL.md", "unknown");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await expect(
      runUpdateSkills([], {
        writeMessage() {},
      }),
    ).rejects.toThrow(/Untracked imported skill directories: orphan/);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(existsSync(skillsLogPath)).toBe(false);
  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
  expect(read(sandbox, "skills/imported/orphan/SKILL.md")).toBe("unknown");
});

test("skills update rejects staged slug mismatches non-interactively without mutating the recipe", async () => {
  const sandbox = makeTempDir("skill-update-script-slug-mismatch");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, {
    skillsLogPath,
    skillsCwdLogPath,
    stagedSlugBySelector: {
      alpha: "renamed-alpha",
    },
  });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await expect(
      runUpdateSkills([], {
        writeMessage() {},
      }),
    ).rejects.toThrow(/recorded alpha but staged renamed-alpha/);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
  expect(existsSync(path.join(sandbox, "skills/imported/renamed-alpha"))).toBe(false);
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
});

test("skills update can interactively accept a staged slug rename", async () => {
  const sandbox = makeTempDir("skill-update-script-slug-accept");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const confirmations: Array<{ recordedSlug: string; stagedSlug: string }> = [];
  const fakeBinDirectory = installFakeNpx(sandbox, {
    skillsLogPath,
    skillsCwdLogPath,
    stagedSlugBySelector: {
      alpha: "renamed-alpha",
    },
  });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runUpdateSkills(["--interactive"], {
      confirmSlugReplacement(request) {
        confirmations.push({
          recordedSlug: request.recordedSlug,
          stagedSlug: request.stagedSlug,
        });
        return true;
      },
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(confirmations).toEqual([
    {
      recordedSlug: "alpha",
      stagedSlug: "renamed-alpha",
    },
  ]);
  expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBe(false);
  expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "renamed-alpha",
          },
        ],
      },
    ],
  });
});

test("skills update can interactively accept multiple staged slug renames", async () => {
  const sandbox = makeTempDir("skill-update-script-multiple-slug-accept");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const confirmations: Array<{ selector: string; recordedSlug: string; stagedSlug: string }> = [];
  const fakeBinDirectory = installFakeNpx(sandbox, {
    skillsLogPath,
    skillsCwdLogPath,
    stagedSlugBySelector: {
      alpha: "renamed-alpha",
      bravo: "renamed-bravo",
    },
  });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
          {
            selector: "bravo",
            slug: "bravo",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
  write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runUpdateSkills(["--interactive"], {
      confirmSlugReplacement(request) {
        confirmations.push({
          selector: request.selector,
          recordedSlug: request.recordedSlug,
          stagedSlug: request.stagedSlug,
        });
        return true;
      },
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(confirmations).toEqual([
    {
      selector: "alpha",
      recordedSlug: "alpha",
      stagedSlug: "renamed-alpha",
    },
    {
      selector: "bravo",
      recordedSlug: "bravo",
      stagedSlug: "renamed-bravo",
    },
  ]);
  expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBe(false);
  expect(existsSync(path.join(sandbox, "skills/imported/bravo"))).toBe(false);
  expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
  expect(read(sandbox, "skills/imported/renamed-bravo/SKILL.md")).toBe("new renamed-bravo");
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "renamed-alpha",
          },
          {
            selector: "bravo",
            slug: "renamed-bravo",
          },
        ],
      },
    ],
  });

  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes",
  );
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill alpha --agent universal --copy --yes",
  );
  expect(skillsLog).toContain(
    "--yes skills add owner/repo --skill bravo --agent universal --copy --yes",
  );
});

test("skills update rejects accepted slug renames that would duplicate another recipe owner", async () => {
  const sandbox = makeTempDir("skill-update-script-slug-duplicate");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, {
    skillsLogPath,
    skillsCwdLogPath,
    failInstallSources: ["z/other"],
    stagedSlugBySelector: {
      alpha: "beta",
    },
  });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "a/renames",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
      {
        source: "z/other",
        skills: [
          {
            selector: "beta",
            slug: "beta",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
  write(sandbox, "skills/imported/beta/SKILL.md", "old beta");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await expect(
      runUpdateSkills(["--interactive"], {
        confirmSlugReplacement() {
          return true;
        },
        writeMessage() {},
      }),
    ).rejects.toThrow(/beta is already owned by recipe z\/other/);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
  expect(read(sandbox, "skills/imported/beta/SKILL.md")).toBe("old beta");
  expect(readImportRecipeStore(sandbox)).toEqual({
    version: 1,
    recipes: [
      {
        source: "a/renames",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
      {
        source: "z/other",
        skills: [
          {
            selector: "beta",
            slug: "beta",
          },
        ],
      },
    ],
  });
});

test("skills update can run local skill install after refreshing recipes", async () => {
  const sandbox = makeTempDir("skill-update-script-install");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const installCalls: string[] = [];
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "owner/repo",
        skills: [
          {
            selector: "alpha",
            slug: "alpha",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runUpdateSkills(["--install"], {
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

test("skills update passes recorded OpenClaw risk acceptance", async () => {
  const sandbox = makeTempDir("skill-update-script-openclaw");
  const skillsLogPath = path.join(sandbox, "skills.log");
  const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const fakeBinDirectory = installFakeNpx(sandbox, { skillsLogPath, skillsCwdLogPath });
  writeImportRecipeStore(sandbox, {
    version: 1,
    recipes: [
      {
        source: "openclaw/agent-skills",
        acceptOpenClawRisks: true,
        skills: [
          {
            selector: "autoreview",
            slug: "autoreview",
          },
        ],
      },
    ],
  });
  write(sandbox, "skills/imported/autoreview/SKILL.md", "old autoreview");

  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);

    await runUpdateSkills([], {
      writeMessage() {},
    });
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }

  const skillsLog = readFileSync(skillsLogPath, "utf8");
  expect(skillsLog).toContain(
    "--yes skills add openclaw/agent-skills --dangerously-accept-openclaw-risks --skill autoreview --agent universal --copy --yes",
  );
  expect(read(sandbox, "skills/imported/autoreview/SKILL.md")).toBe("new autoreview");
});

function installFakeNpx(
  sandbox: string,
  options: {
    skillsLogPath: string;
    skillsCwdLogPath: string;
    failInstallSources?: string[];
    stagedSlugBySelector?: Record<string, string>;
  },
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

source_arg=""
previous_was_add=0
for arg in "$@"; do
  if [ "$previous_was_add" = "1" ]; then
    source_arg="$arg"
    previous_was_add=0
    continue
  fi
  if [ "$arg" = "add" ]; then
    previous_was_add=1
  fi
done
case "$source_arg" in
${options.failInstallSources?.map((source) => `  ${source}) echo "failed $source" >&2; exit 42 ;;`).join("\n") ?? ""}
  *) ;;
esac

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
selected_skills=""
previous_was_skill=0
for arg in "$@"; do
  if [ "$previous_was_skill" = "1" ]; then
    selected_skills="$selected_skills $arg"
    previous_was_skill=0
    continue
  fi
  if [ "$arg" = "--skill" ]; then
    previous_was_skill=1
  fi
done
if [ -z "$selected_skills" ]; then
  selected_skills=" alpha bravo"
fi
for skill in $selected_skills; do
  staged_slug="$skill"
  case "$skill" in
${Object.entries(options.stagedSlugBySelector ?? {})
  .map(([selector, slug]) => `    ${selector}) staged_slug="${slug}" ;;`)
  .join("\n")}
    *) ;;
  esac
  mkdir -p ".agents/skills/$staged_slug"
  printf 'new %s' "$staged_slug" > ".agents/skills/$staged_slug/SKILL.md"
done
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
