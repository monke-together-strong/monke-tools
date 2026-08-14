import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import pc from "picocolors";
import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

import {
  buildGroupedSkillOptions,
  extractSecurityRiskAssessment,
  normalizeSourceForStaging,
  parseAvailableSkillGroups,
  parseAvailableSkillNames,
  readImportRecipeStore,
  recordImportedGuidance,
  runImportSkills,
  writeImportRecipeStore
} from "../scripts/import-skills.ts";
import { runUpdateSkills } from "../scripts/update-skills.ts";
import { makeTempDir, read, write } from "./helpers.ts";

describe("skill importing", () => {
  test("parseAvailableSkillGroups preserves group headings from skills list output", () => {
    const output = [
      "\u001B[?25l\u2502",
      "\u25C7  Available Skills",
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
      "\u2514  Use --skill <name> to install specific skills"
    ].join("\n");

    expect(parseAvailableSkillGroups(output)).toStrictEqual([
      {
        name: "Engineering",
        skills: ["alpha-skill"]
      },
      {
        name: "Personal Tools",
        skills: ["Bravo Skill"]
      }
    ]);
    expect(parseAvailableSkillNames(output)).toStrictEqual(["alpha-skill", "Bravo Skill"]);
  });

  test("buildGroupedSkillOptions keeps Clack group labels separate from skill values", () => {
    expect(
      buildGroupedSkillOptions([
        {
          name: "Engineering",
          skills: ["alpha", "bravo"]
        },
        {
          name: "Writing",
          skills: ["charlie"]
        }
      ])
    ).toStrictEqual({
      Engineering: [
        {
          label: "alpha",
          value: "alpha"
        },
        {
          label: "bravo",
          value: "bravo"
        }
      ],
      Writing: [
        {
          label: "charlie",
          value: "charlie"
        }
      ]
    });
  });

  test("parseAvailableSkillNames fails when skills list output is unrecognized", () => {
    expect(() => parseAvailableSkillNames("No skills here")).toThrow(/Could not parse/u);
  });

  test("extractSecurityRiskAssessment filters upstream install output down to security details", () => {
    const output = [
      "\u25C7  Installation Summary",
      "\u2502  ./.agents/skills/alpha",
      "\u25C7  Security Risk Assessments",
      "\u2502  alpha  Safe  0 alerts  Low Risk",
      "\u2502  Details: https://skills.sh/owner/repo",
      "\u251C\u2500\u2500\u2500\u256F",
      "\u2502",
      "\u25C7  Installation complete",
      "\u25C7  Installed 1 skill",
      "\u2502  \u2192 ./.agents/skills/alpha"
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
      recipes: [
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            },
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "z-owner/z-repo"
        },
        {
          skills: [
            {
              kind: "skill",
              selector: "zulu",
              slug: "zulu"
            }
          ],
          source: "a-owner/a-repo"
        }
      ],
      version: 3
    });

    expect(read(sandbox, "skills/imported/.monke-imports.json")).toBe(`{
  "recipes": [
    {
      "skills": [
        {
          "kind": "skill",
          "selector": "zulu",
          "slug": "zulu"
        }
      ],
      "source": "a-owner/a-repo"
    },
    {
      "acceptOpenClawRisks": true,
      "skills": [
        {
          "kind": "skill",
          "selector": "alpha",
          "slug": "alpha"
        },
        {
          "disableModelInvocation": false,
          "kind": "skill",
          "selector": "bravo",
          "slug": "bravo"
        }
      ],
      "source": "z-owner/z-repo"
    }
  ],
  "version": 3
}
`);
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "zulu",
              slug: "zulu"
            }
          ],
          source: "a-owner/a-repo"
        },
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "z-owner/z-repo"
        }
      ],
      version: 3
    });
  });

  test("skill import recipe store rejects duplicate recipe sources", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate-source");
    write(
      sandbox,
      "skills/imported/.monke-imports.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/repo"
          },
          {
            skills: [
              {
                kind: "skill",
                selector: "bravo",
                slug: "bravo"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      })
    );

    expect(() => readImportRecipeStore(sandbox)).toThrow(
      /Duplicate skill import recipe source: owner\/repo/u
    );
  });

  test("skill import recipe store rejects unknown future versions", () => {
    const sandbox = makeTempDir("skill-import-recipes-future-version");
    write(
      sandbox,
      "skills/imported/.monke-imports.json",
      JSON.stringify({ recipes: [], version: 4 })
    );

    expect(() => readImportRecipeStore(sandbox)).toThrow(/version.*must be 3/u);
  });

  test("skill import recipe store rejects non-boolean model invocation overrides", () => {
    const sandbox = makeTempDir("skill-import-recipes-invalid-invocation-override");
    write(
      sandbox,
      "skills/imported/.monke-imports.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                disableModelInvocation: "yes",
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      })
    );

    expect(() => readImportRecipeStore(sandbox)).toThrow(/disableModelInvocation.*boolean/u);
  });

  test("skill import recipe store rejects duplicate selectors in one recipe", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate-selector");
    write(
      sandbox,
      "skills/imported/.monke-imports.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              },
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha-v2"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      })
    );

    expect(() => readImportRecipeStore(sandbox)).toThrow(
      /Duplicate skill selector in recipe owner\/repo: alpha/u
    );
  });

  test("skill import recipe store rejects duplicate imported skill owners", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate-owner");
    write(
      sandbox,
      "skills/imported/.monke-imports.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/first"
          },
          {
            skills: [
              {
                kind: "skill",
                selector: "other-alpha",
                slug: "alpha"
              }
            ],
            source: "owner/second"
          }
        ],
        version: 3
      })
    );

    expect(() => readImportRecipeStore(sandbox)).toThrow(
      /Imported skill slug alpha is owned by both owner\/first and owner\/second/u
    );
  });

  test("skill import recipe store allows one slug to be owned once per Import kind", () => {
    const sandbox = makeTempDir("skill-import-recipes-kind-scoped-owner");
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "reference", selector: "alpha-reference", slug: "alpha" }],
          source: "owner/reference"
        },
        {
          skills: [{ kind: "skill", selector: "alpha-skill", slug: "alpha" }],
          source: "owner/skill"
        }
      ],
      version: 3
    });

    expect(readImportRecipeStore(sandbox).recipes).toStrictEqual([
      {
        skills: [{ kind: "reference", selector: "alpha-reference", slug: "alpha" }],
        source: "owner/reference"
      },
      {
        skills: [{ kind: "skill", selector: "alpha-skill", slug: "alpha" }],
        source: "owner/skill"
      }
    ]);
  });

  test("skill import recipe recording rejects one source mapping two selectors to one slug", () => {
    const sandbox = makeTempDir("skill-import-recipes-source-slug");
    recordImportedGuidance(sandbox, {
      acceptOpenClawRisks: false,
      kind: "reference",
      skills: [{ selector: "alpha-reference", slug: "alpha" }],
      source: "owner/repo"
    });

    expect(() => {
      recordImportedGuidance(sandbox, {
        acceptOpenClawRisks: false,
        kind: "skill",
        skills: [{ selector: "alpha-skill", slug: "alpha" }],
        source: "owner/repo"
      });
    }).toThrow(/Duplicate imported slug in recipe owner\/repo: alpha/u);
  });

  test("skill import recipe recording rejects duplicate imported skill owners", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate");
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/first"
        }
      ],
      version: 3
    });

    expect(() => {
      recordImportedGuidance(sandbox, {
        acceptOpenClawRisks: false,
        kind: "skill",
        skills: [
          {
            selector: "other-alpha",
            slug: "alpha"
          }
        ],
        source: "owner/second"
      });
    }).toThrow(/alpha is already owned by recipe owner\/first/u);
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/first"
        }
      ],
      version: 3
    });
  });

  test("skills import script wraps npx skills and copies staged universal skills", async () => {
    const sandbox = makeTempDir("skill-import-script");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    let stdout = "";
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo"], {
        selectSkills(availableSkillGroups) {
          expect(availableSkillGroups).toStrictEqual([
            {
              name: "Engineering",
              skills: ["alpha"]
            },
            {
              name: "Productivity",
              skills: ["bravo"]
            }
          ]);
          return ["alpha", "bravo"];
        },
        writeMessage(message) {
          stdout += message;
        }
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
    expect(existsSync(path.join(sandbox, ".agents"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills-lock.json"))).toBeFalsy();

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain("--yes skills add owner/repo -l");
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );

    const stagingCwds = readFileSync(skillsCwdLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(stagingCwds).toHaveLength(2);
    expect(stagingCwds.every((cwd) => cwd !== sandbox)).toBeTruthy();
    expect(stagingCwds.every((cwd) => !existsSync(cwd))).toBeTruthy();
  });

  test("skills import --ref creates a non-discoverable Imported reference and records its kind", async () => {
    const sandbox = makeTempDir("skill-import-reference");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo", "--ref"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha/SKILL.md"))).toBeFalsy();
    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    expect(read(sandbox, "skills/references/imported/alpha/references/details.md")).toBe(
      "supporting details\n"
    );
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "reference",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("reference import rejects a symlinked root entry without writing through it", async () => {
    const sandbox = makeTempDir("skill-import-reference-symlink");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const outsideEntryPath = path.join(sandbox, "outside-entry.md");
    const outsideEntry = `---
name: outside-entry
---

# Must stay unchanged
`;
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    writeFileSync(outsideEntryPath, outsideEntry, "utf-8");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSkillEntrySymlinkTarget: outsideEntryPath,
      stageReferenceFixture: true
    });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runImportSkills(["owner/repo", "--ref"], {
          selectSkills() {
            return ["alpha"];
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/regular file/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(readFileSync(outsideEntryPath, "utf-8")).toBe(outsideEntry);
    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills/imported/.monke-imports.json"))).toBeFalsy();
  });

  test("reference import preserves relative symlinks between supporting files", async () => {
    const sandbox = makeTempDir("skill-import-reference-supporting-symlink");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true,
      stageSupportingSymlink: true
    });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo", "--ref"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    const importedLink = path.join(
      sandbox,
      "skills/references/imported/alpha/references/details-link.md"
    );
    expect(readlinkSync(importedLink)).toBe("details.md");
    expect(readFileSync(importedLink, "utf-8")).toBe("supporting details\n");
  });

  test("re-importing one selector with the opposite Import kind migrates its managed copy", async () => {
    const sandbox = makeTempDir("skill-import-kind-migration");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "skill", selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old skill");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo", "--ref"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
      expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
      expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
        "\n# Alpha\n\nReference body.\n"
      );

      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toMatch(/^---\nname: alpha\n/u);
    expect(readImportRecipeStore(sandbox).recipes[0]?.skills).toStrictEqual([
      { kind: "skill", selector: "alpha", slug: "alpha" }
    ]);
  });

  test.each(["internal", "codex"])(
    "re-import rejects migrating an Imported reference used by a %s skill",
    async (skillFolder) => {
      const sandbox = makeTempDir("skill-import-consumed-reference");
      const skillsLogPath = path.join(sandbox, "skills.log");
      const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
      const originalCwd = process.cwd();
      const originalPath = process.env.PATH;
      const originalStore = {
        recipes: [
          {
            skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
            source: "owner/repo"
          }
        ],
        version: 3 as const
      };
      const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
      writeImportRecipeStore(sandbox, originalStore);
      write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
      write(
        sandbox,
        `skills/${skillFolder}/reviewer/SKILL.md`,
        "[Base](../../references/imported/alpha/MAIN.md)\n"
      );

      try {
        process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
        process.chdir(sandbox);

        await expect(
          runImportSkills(["owner/repo"], {
            selectSkills() {
              return ["alpha"];
            },
            writeMessage() {}
          })
        ).rejects.toThrow(`used by skills/${skillFolder}/reviewer/SKILL.md`);
      } finally {
        process.chdir(originalCwd);
        process.env.PATH = originalPath;
      }

      expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
      expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
      expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
    }
  );

  test("a reference MAIN.md collision leaves every selected managed copy and recipe unchanged", async () => {
    const sandbox = makeTempDir("skill-import-reference-collision");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      mainCollisionSelector: "bravo",
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    const originalStore = {
      recipes: [
        {
          skills: [
            { kind: "skill" as const, selector: "alpha", slug: "alpha" },
            { kind: "skill" as const, selector: "bravo", slug: "bravo" }
          ],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runImportSkills(["owner/repo", "--ref"], {
          selectSkills() {
            return ["alpha", "bravo"];
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/already contains MAIN\.md/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("old bravo");
    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills/references/imported/bravo"))).toBeFalsy();
    expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
  });

  test("skills import script records selected skills and merges compatible same-source recipes", async () => {
    const sandbox = makeTempDir("skill-import-script-recipes");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["bravo"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("skills import script resolves multiple selector slug aliases", async () => {
    const sandbox = makeTempDir("skill-import-script-aliases");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha",
        bravo: "renamed-bravo"
      }
    });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["alpha", "bravo"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
    expect(read(sandbox, "skills/imported/renamed-bravo/SKILL.md")).toBe("new renamed-bravo");
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "renamed-alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "renamed-bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill alpha --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill bravo --agent universal --copy --yes"
    );
  });

  test("skills import script passes and records explicit OpenClaw risk acceptance", async () => {
    const sandbox = makeTempDir("skill-import-openclaw");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["openclaw/agent-skills", "--accept-openclaw-risks"], {
        selectSkills() {
          return ["autoreview"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills add openclaw/agent-skills --dangerously-accept-openclaw-risks -l"
    );
    expect(skillsLog).toContain(
      "--yes skills add openclaw/agent-skills --dangerously-accept-openclaw-risks --skill autoreview --agent universal --copy --yes"
    );
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              kind: "skill",
              selector: "autoreview",
              slug: "autoreview"
            }
          ],
          source: "openclaw/agent-skills"
        }
      ],
      version: 3
    });
  });

  test("reference import preserves security, OpenClaw risk, and optional-install behavior", async () => {
    const sandbox = makeTempDir("skill-import-reference-openclaw-install");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const installCalls: string[] = [];
    let stdout = "";
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(
        ["openclaw/agent-skills", "--ref", "--accept-openclaw-risks", "--install"],
        {
          runInstallCommand(repoRoot) {
            installCalls.push(repoRoot);
            expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
              "\n# Alpha\n\nReference body.\n"
            );
          },
          selectSkills() {
            return ["alpha"];
          },
          writeMessage(message) {
            stdout += message;
          }
        }
      );
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(stripAnsiForTest(stdout)).toContain("Security Risk Assessments");
    expect(installCalls).toStrictEqual([sandbox]);
    expect(readImportRecipeStore(sandbox).recipes[0]).toStrictEqual({
      acceptOpenClawRisks: true,
      skills: [{ kind: "reference", selector: "alpha", slug: "alpha" }],
      source: "openclaw/agent-skills"
    });
  });

  test("skills import script rejects local slug ownership conflicts before copying", async () => {
    const sandbox = makeTempDir("skill-import-script-conflict");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/first"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runImportSkills(["owner/second"], {
          selectSkills() {
            return ["alpha"];
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/alpha is already owned by recipe owner\/first/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/first"
        }
      ],
      version: 3
    });
  });

  test("skills import script can run local skill install after importing with -i", async () => {
    const sandbox = makeTempDir("skill-import-script-install");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const installCalls: string[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runImportSkills(["owner/repo", "-i"], {
        runInstallCommand(repoRoot) {
          installCalls.push(repoRoot);
          expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
        },
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(installCalls).toStrictEqual([sandbox]);
  });

  test("skills update reruns recorded recipes without prompting for selection", async () => {
    const sandbox = makeTempDir("skill-update-script");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    let stdout = "";
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills([], {
        writeMessage(message) {
          stdout += message;
        }
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
    expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
    expect(stripAnsiForTest(stdout)).toContain("Security Risk Assessments");
    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );
    expect(skillsLog).not.toContain("-l");
  });

  test("skills update preserves upstream invocation metadata when no override is recorded", async () => {
    const sandbox = makeTempDir("skill-update-invocation-preserve");
    const skillMarkdown = `---
name: alpha
disable-model-invocation: true
metadata:
  owner: upstream
---

# Alpha
`;
    const openaiYaml = `interface:
  display_name: Alpha
policy:
  allow_implicit_invocation: false
`;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": openaiYaml,
          "SKILL.md": skillMarkdown
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "skill", selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe(skillMarkdown);
    expect(read(sandbox, "skills/imported/alpha/agents/openai.yaml")).toBe(openaiYaml);
  });

  test("skills update disables model invocation on Claude and Codex when explicitly requested", async () => {
    const sandbox = makeTempDir("skill-update-invocation-disabled");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": `interface:
  display_name: Alpha
  short_description: Upstream description
policy:
  allow_implicit_invocation: true
  network: false
`,
          "SKILL.md": `---
name: alpha
disable-model-invocation: false
user-invocable: true
metadata:
  owner: upstream
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    const skillMarkdown = read(sandbox, "skills/imported/alpha/SKILL.md");
    expect(skillMarkdown).toContain("disable-model-invocation: true");
    expect(skillMarkdown).toContain("user-invocable: true");
    expect(skillMarkdown).toContain("owner: upstream");
    expect(skillMarkdown).toContain("# Alpha");
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      interface: {
        display_name: "Alpha",
        short_description: "Upstream description"
      },
      policy: {
        allow_implicit_invocation: false,
        network: false
      }
    });
  });

  test("skills update enables model invocation on Claude and Codex when explicitly requested", async () => {
    const sandbox = makeTempDir("skill-update-invocation-enabled");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": `policy:
  allow_implicit_invocation: false
`,
          "SKILL.md": `---
name: alpha
disable-model-invocation: true
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toContain(
      "disable-model-invocation: false"
    );
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      policy: { allow_implicit_invocation: true }
    });
  });

  test("skills update creates canonical Codex metadata for an explicit invocation override", async () => {
    const sandbox = makeTempDir("skill-update-invocation-create-codex");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "SKILL.md": `---
name: alpha
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    expect(read(sandbox, "skills/imported/alpha/agents/openai.yaml")).toBe(
      "policy:\n  allow_implicit_invocation: false\n"
    );
  });

  test("skills update normalizes legacy Codex metadata before applying an invocation override", async () => {
    const sandbox = makeTempDir("skill-update-invocation-normalize-codex");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yml": `interface:
  display_name: Legacy Alpha
policy:
  network: false
`,
          "SKILL.md": `---
name: alpha
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(existsSync(path.join(sandbox, "skills/imported/alpha/agents/openai.yml"))).toBeFalsy();
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      interface: { display_name: "Legacy Alpha" },
      policy: {
        allow_implicit_invocation: true,
        network: false
      }
    });
  });

  test("skills update removes duplicate legacy Codex metadata", async () => {
    const sandbox = makeTempDir("skill-update-invocation-remove-legacy-codex");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": `interface:
  display_name: Canonical Alpha
`,
          "agents/openai.yml": `interface:
  display_name: Legacy Alpha
`,
          "SKILL.md": `---
name: alpha
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(existsSync(path.join(sandbox, "skills/imported/alpha/agents/openai.yml"))).toBeFalsy();
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      interface: { display_name: "Canonical Alpha" },
      policy: { allow_implicit_invocation: false }
    });
  });

  test("skills update refreshes an Imported reference without recreating an Imported skill", async () => {
    const sandbox = makeTempDir("skill-update-reference");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "reference",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills([], {
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    expect(read(sandbox, "skills/references/imported/alpha/references/details.md")).toBe(
      "supporting details\n"
    );
    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha/agents"))).toBeFalsy();
  });

  test("skills update keeps previous guidance and its recipe when invocation metadata is invalid", async () => {
    const sandbox = makeTempDir("skill-update-invocation-atomic-failure");
    const originalStore = {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill" as const,
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": "interface:\n  display_name: Alpha\n",
          "SKILL.md": `---
name: alpha
metadata: [unterminated
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/imported/alpha/SKILL.md", "previous alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(runUpdateSkills([], { writeMessage() {} })).rejects.toThrow(
        /Invalid Skill frontmatter/u
      );
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("previous alpha");
    expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update continues through later recipes after one recipe fails", async () => {
    const sandbox = makeTempDir("skill-update-script-failure");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      failInstallSources: ["owner/fails"],
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/fails"
        },
        {
          skills: [
            {
              kind: "reference",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/works"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/references/imported/bravo/MAIN.md", "old bravo");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills([], {
          writeMessage() {}
        })
      ).rejects.toThrow(/owner\/fails/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/references/imported/bravo/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills add owner/fails --skill alpha --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills add owner/works --skill bravo --agent universal --copy --yes"
    );
  });

  test("skills update rejects untracked imported skill directories before invoking upstream", async () => {
    const sandbox = makeTempDir("skill-update-script-untracked");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/orphan/SKILL.md", "unknown");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills([], {
          writeMessage() {}
        })
      ).rejects.toThrow(/Untracked imported skill directories: orphan/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(existsSync(skillsLogPath)).toBeFalsy();
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
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills([], {
          writeMessage() {}
        })
      ).rejects.toThrow(/recorded alpha but staged renamed-alpha/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(existsSync(path.join(sandbox, "skills/imported/renamed-alpha"))).toBeFalsy();
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("skills update can interactively accept a staged slug rename", async () => {
    const sandbox = makeTempDir("skill-update-script-slug-accept");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const confirmations: { recordedSlug: string; stagedSlug: string }[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement(request) {
          confirmations.push({
            recordedSlug: request.recordedSlug,
            stagedSlug: request.stagedSlug
          });
          return true;
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(confirmations).toStrictEqual([
      {
        recordedSlug: "alpha",
        stagedSlug: "renamed-alpha"
      }
    ]);
    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "renamed-alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("skills update preserves reference transformation across an accepted slug rename", async () => {
    const sandbox = makeTempDir("skill-update-reference-slug-accept");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "reference", selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement() {
          return true;
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(
      existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha/SKILL.md"))
    ).toBeFalsy();
    expect(read(sandbox, "skills/references/imported/renamed-alpha/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    expect(readImportRecipeStore(sandbox).recipes[0]?.skills).toStrictEqual([
      { kind: "reference", selector: "alpha", slug: "renamed-alpha" }
    ]);
  });

  test("skills update rejects renaming an Imported reference used by a Reference-backed skill", async () => {
    const sandbox = makeTempDir("skill-update-consumed-reference");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(
      sandbox,
      "skills/internal/reviewer/SKILL.md",
      "[Base](../../references/imported/alpha/MAIN.md)\n"
    );

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/internal\/reviewer\/SKILL\.md/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update detects a supporting document that consumes a reference support file", async () => {
    const sandbox = makeTempDir("skill-update-consumed-reference-support");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(sandbox, "skills/internal/reviewer/SKILL.md", "# Reviewer\n");
    write(
      sandbox,
      "skills/internal/reviewer/references/checklist.md",
      "[Details](../../../references/imported/alpha/references/details.md)\n"
    );

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/internal\/reviewer\/references\/checklist\.md/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update detects a supporting symlink that consumes a reference file", async () => {
    const sandbox = makeTempDir("skill-update-consumed-reference-symlink");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(sandbox, "skills/internal/reviewer/SKILL.md", "# Reviewer\n");
    const supportingSymlink = path.join(sandbox, "skills/internal/reviewer/references/base.md");
    mkdirSync(path.dirname(supportingSymlink), { recursive: true });
    symlinkSync("../../../references/imported/alpha/MAIN.md", supportingSymlink);

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/internal\/reviewer\/references\/base\.md/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update detects reference documents and symlinks that consume another reference", async () => {
    const sandbox = makeTempDir("skill-update-reference-consumer");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/a-alpha"
        },
        {
          skills: [{ kind: "reference" as const, selector: "bravo", slug: "bravo" }],
          source: "owner/z-bravo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(sandbox, "skills/references/imported/bravo/MAIN.md", "[Alpha](../alpha/MAIN.md)\n");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/references\/imported\/bravo\/MAIN\.md/u);

      write(sandbox, "skills/references/imported/bravo/MAIN.md", "# Bravo\n");
      const internalReferenceSymlink = path.join(
        sandbox,
        "skills/references/internal/reviewer/alpha.md"
      );
      mkdirSync(path.dirname(internalReferenceSymlink), { recursive: true });
      symlinkSync("../../imported/alpha/MAIN.md", internalReferenceSymlink);

      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/references\/internal\/reviewer\/alpha\.md/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(readImportRecipeStore(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update can interactively accept multiple staged slug renames", async () => {
    const sandbox = makeTempDir("skill-update-script-multiple-slug-accept");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const confirmations: { recordedSlug: string; selector: string; stagedSlug: string }[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha",
        bravo: "renamed-bravo"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement(request) {
          confirmations.push({
            recordedSlug: request.recordedSlug,
            selector: request.selector,
            stagedSlug: request.stagedSlug
          });
          return true;
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(confirmations).toStrictEqual([
      {
        recordedSlug: "alpha",
        selector: "alpha",
        stagedSlug: "renamed-alpha"
      },
      {
        recordedSlug: "bravo",
        selector: "bravo",
        stagedSlug: "renamed-bravo"
      }
    ]);
    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills/imported/bravo"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
    expect(read(sandbox, "skills/imported/renamed-bravo/SKILL.md")).toBe("new renamed-bravo");
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "renamed-alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "renamed-bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill alpha --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills add owner/repo --skill bravo --agent universal --copy --yes"
    );
  });

  test("skills update validates accepted slug renames against projected ownership", async () => {
    const sandbox = makeTempDir("skill-update-projected-slug-ownership");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "bravo",
        bravo: "charlie"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            { kind: "skill", selector: "alpha", slug: "alpha" },
            { kind: "skill", selector: "bravo", slug: "bravo" }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement() {
          return true;
        },
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
    expect(read(sandbox, "skills/imported/charlie/SKILL.md")).toBe("new charlie");
    expect(readImportRecipeStore(sandbox).recipes[0]?.skills).toStrictEqual([
      { kind: "skill", selector: "alpha", slug: "bravo" },
      { kind: "skill", selector: "bravo", slug: "charlie" }
    ]);
  });

  test("skills update rejects accepted slug renames that would duplicate another recipe owner", async () => {
    const sandbox = makeTempDir("skill-update-script-slug-duplicate");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      failInstallSources: ["z/other"],
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "beta"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "a/renames"
        },
        {
          skills: [
            {
              kind: "skill",
              selector: "beta",
              slug: "beta"
            }
          ],
          source: "z/other"
        }
      ],
      version: 3
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
          writeMessage() {}
        })
      ).rejects.toThrow(/beta is owned by both a\/renames and z\/other/u);
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/imported/beta/SKILL.md")).toBe("old beta");
    expect(readImportRecipeStore(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "a/renames"
        },
        {
          skills: [
            {
              kind: "skill",
              selector: "beta",
              slug: "beta"
            }
          ],
          source: "z/other"
        }
      ],
      version: 3
    });
  });

  test("skills update can run local skill install after refreshing recipes", async () => {
    const sandbox = makeTempDir("skill-update-script-install");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const installCalls: string[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
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
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    expect(installCalls).toStrictEqual([sandbox]);
  });

  test("skills update passes recorded OpenClaw risk acceptance", async () => {
    const sandbox = makeTempDir("skill-update-script-openclaw");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              kind: "skill",
              selector: "autoreview",
              slug: "autoreview"
            }
          ],
          source: "openclaw/agent-skills"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/autoreview/SKILL.md", "old autoreview");

    try {
      process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
      process.chdir(sandbox);

      await runUpdateSkills([], {
        writeMessage() {}
      });
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills add openclaw/agent-skills --dangerously-accept-openclaw-risks --skill autoreview --agent universal --copy --yes"
    );
    expect(read(sandbox, "skills/imported/autoreview/SKILL.md")).toBe("new autoreview");
  });
});

async function withFakeNpx(sandbox: string, fakeBinDirectory: string, action: () => Promise<void>) {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);
    await action();
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
  }
}

function installFakeNpx(
  sandbox: string,
  options: {
    failInstallSources?: string[];
    mainCollisionSelector?: string;
    skillsCwdLogPath: string;
    skillsLogPath: string;
    stagedGuidance?: Record<string, Record<string, string>>;
    stagedSkillEntrySymlinkTarget?: string;
    stagedSlugBySelector?: Record<string, string>;
    stageReferenceFixture?: boolean;
    stageSupportingSymlink?: boolean;
  }
) {
  const binDirectory = path.join(sandbox, "fake-bin");
  const guidanceFixturesDirectory = path.join(sandbox, "fake-upstream-guidance");
  mkdirSync(binDirectory, { recursive: true });
  for (const [selector, files] of Object.entries(options.stagedGuidance ?? {})) {
    for (const [relativePath, contents] of Object.entries(files)) {
      write(sandbox, path.join("fake-upstream-guidance", selector, relativePath), contents);
    }
  }
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
\u25C7  Available Skills
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
  if [ -d '${guidanceFixturesDirectory}'/"$skill" ]; then
    cp -R '${guidanceFixturesDirectory}'/"$skill"/. ".agents/skills/$staged_slug/"
  else
${
  options.stageReferenceFixture === true
    ? `  cat > ".agents/skills/$staged_slug/SKILL.md" <<'SKILL'
---
name: alpha
description: Reference fixture
metadata:
  owner: upstream
---

# Alpha

Reference body.
SKILL
  mkdir -p ".agents/skills/$staged_slug/references"
  printf 'supporting details\\n' > ".agents/skills/$staged_slug/references/details.md"
${
  options.stageSupportingSymlink === true
    ? `  ln -s 'details.md' ".agents/skills/$staged_slug/references/details-link.md"`
    : ""
}`
    : `  printf 'new %s' "$staged_slug" > ".agents/skills/$staged_slug/SKILL.md"`
}
  fi
${
  options.mainCollisionSelector
    ? `  if [ "$skill" = "${options.mainCollisionSelector}" ]; then
    printf 'upstream collision\\n' > ".agents/skills/$staged_slug/MAIN.md"
  fi`
    : ""
}
${
  options.stagedSkillEntrySymlinkTarget
    ? `  rm ".agents/skills/$staged_slug/SKILL.md"
  ln -s '${options.stagedSkillEntrySymlinkTarget}' ".agents/skills/$staged_slug/SKILL.md"`
    : ""
}
done
printf '{"version":1}' > skills-lock.json
exit 0
`,
    "utf-8"
  );
  chmodSync(scriptPath, 0o755);
  return binDirectory;
}

function stripAnsiForTest(value: string) {
  const escapeCharacter = String.fromCodePoint(27);
  return value.replaceAll(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu"), "");
}
