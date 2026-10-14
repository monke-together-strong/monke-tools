import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { containsPath } from "./path-identity.ts";

export const SKILL_SOURCE_CANDIDATES = [
  ".agents/skills",
  "skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills"
];

/** Choose one skill source folder from a checkout or installer output. */
export function resolveSkillSourceFolder(
  directory: string,
  preserveAlias = false,
  preferPublishedSkills = false
) {
  if (existsSync(path.join(directory, "SKILL.md"))) {
    return preserveAlias ? directory : realpathSync.native(directory);
  }
  // A project may publish skills/ while consuming unrelated skills in .agents/skills.
  const folders = preferPublishedSkills
    ? ["skills", ...SKILL_SOURCE_CANDIDATES.filter((candidate) => candidate !== "skills")]
    : SKILL_SOURCE_CANDIDATES;
  const candidates = folders.map((candidate) => path.join(directory, candidate));
  const root = candidates.find((candidate) => existsSync(candidate)) ?? directory;
  return existsSync(root) && !preserveAlias ? realpathSync.native(root) : root;
}

/** Scan Skill directories and their existing ancestors without following cycles. */
export function scanSkillSource(root: string, includeNestedSkills = false) {
  if (!existsSync(root)) {
    throw new MonkeError(`Skill source is missing: ${root}`);
  }
  const skills: string[] = [];
  const directories = new Set<string>();
  const ancestors = new Set<string>();
  function visit(directory: string) {
    const physicalDirectory = realpathSync.native(directory);
    if (ancestors.has(physicalDirectory)) {
      return;
    }
    directories.add(directory);
    if (existsSync(path.join(directory, "SKILL.md"))) {
      skills.push(directory);
      if (!includeNestedSkills) {
        return;
      }
    }
    ancestors.add(physicalDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        (entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            statSync(path.join(directory, entry.name), {
              throwIfNoEntry: false
            })?.isDirectory())) &&
        !entry.name.startsWith(".") &&
        !["node_modules", "references"].includes(entry.name)
      ) {
        visit(path.join(directory, entry.name));
      }
    }
    ancestors.delete(physicalDirectory);
  }
  visit(root);
  return { directories, skills };
}

/** Discover Skills without asking which agent should receive them. */
export function discoverSourceSkills(root: string, excludedRoot?: string) {
  const skills = new Map<string, string>();
  for (const directory of scanSkillSource(root).skills) {
    if (excludedRoot && containsPath(excludedRoot, directory)) {
      continue;
    }
    const slug = path.basename(directory);
    if (skills.has(slug)) {
      throw new MonkeError(`Duplicate Skill slug ${slug} in ${root}`);
    }
    skills.set(slug, directory);
  }
  return skills;
}

/** Keep duplicate slugs visible so adoption can compare them before publishing. */
export function discoverSourceSkillCopies(root: string) {
  return scanSkillSource(root).skills;
}
