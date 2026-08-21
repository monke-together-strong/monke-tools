import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { MonkeError } from "./errors.ts";
import type { SkillInstallTargetKind } from "./global-config.ts";
import { assertDirectoryMutationAccess } from "./path-boundary.ts";
import { parseBoundaryValue } from "./validation.ts";

const GLOBAL_INSTRUCTIONS_RELATIVE_PATH = path.join("instructions", "GLOBAL.md");
const MANAGED_INSTRUCTIONS_START = "<!-- monke-rules:start -->";
const MANAGED_INSTRUCTIONS_END = "<!-- monke-rules:end -->";

interface GlobalInstructionsOptions {
  cwd: string;
  environment?: Record<string, string | undefined>;
  homeDirectory: string;
}

const ConfiguredDirectorySchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Must not be empty"
});

/** Validate a known Global instruction destination without changing it. */
export function preflightGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions & { guidanceSourceRoot: string }
) {
  const prepared = prepareGlobalInstructions(target, options);
  if (prepared === null) {
    return;
  }
  assertGlobalInstructionsWritable(prepared.filePath);
}

/** Validate removal from a known Global instruction destination without changing it. */
export function preflightRemoveGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions
) {
  const prepared = prepareGlobalInstructionsRemoval(target, options);
  if (prepared === null) {
    return;
  }
  assertGlobalInstructionsWritable(prepared.filePath);
}

/** Reconcile the selected harness's Managed instruction section from the source snapshot. */
export function reconcileGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions & { guidanceSourceRoot: string }
) {
  const prepared = prepareGlobalInstructions(target, options);
  if (prepared === null) {
    return;
  }
  mkdirSync(path.dirname(prepared.filePath), { recursive: true });
  writeFileSync(prepared.filePath, prepared.nextContent);
}

function prepareGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions & { guidanceSourceRoot: string }
) {
  const destinationPath = globalInstructionsPath(target, options);
  if (destinationPath === null) {
    return null;
  }
  const filePath = resolveInstructionFile(destinationPath);
  const body = readFileSync(
    path.join(options.guidanceSourceRoot, GLOBAL_INSTRUCTIONS_RELATIVE_PATH),
    "utf-8"
  );
  const existingContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  return {
    filePath,
    nextContent: reconcileManagedInstructions(existingContent, body, target.kind === "codex")
  };
}

function assertGlobalInstructionsWritable(filePath: string) {
  if (existsSync(filePath)) {
    try {
      accessSync(filePath, fsConstants.W_OK);
      return;
    } catch {
      throw new MonkeError(`Global agent instructions are not writable: ${filePath}`);
    }
  }

  assertDirectoryMutationAccess(path.dirname(filePath), "Global agent instructions parent");
}

/** Remove the selected harness's Managed instruction section without touching user guidance. */
export function removeGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions
) {
  const prepared = prepareGlobalInstructionsRemoval(target, options);
  if (prepared === null) {
    return;
  }
  writeFileSync(prepared.filePath, prepared.nextContent);
}

function prepareGlobalInstructionsRemoval(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions
) {
  const destinationPath = globalInstructionsPath(target, options);
  if (
    destinationPath === null ||
    lstatSync(destinationPath, { throwIfNoEntry: false }) === undefined
  ) {
    return null;
  }
  const filePath = resolveInstructionFile(destinationPath);
  const existingContent = readFileSync(filePath, "utf-8");
  const markers = findManagedInstructionMarkers(existingContent);
  if (markers === null) {
    return null;
  }
  return {
    filePath,
    nextContent: `${existingContent.slice(0, markers.start)}${existingContent.slice(markers.end)}`
  };
}

function reconcileManagedInstructions(
  existingContent: string | null,
  body: string,
  adoptWholeFileMatch: boolean
) {
  if (existingContent === null) {
    return renderManagedInstructions(body);
  }
  if (existingContent.length === 0) {
    return renderManagedInstructions(body);
  }
  if (adoptWholeFileMatch && existingContent === body) {
    return renderManagedInstructions(body);
  }

  const markers = findManagedInstructionMarkers(existingContent);
  if (markers === null) {
    return `${existingContent}${renderManagedInstructions(body)}`;
  }

  const managedSection = renderManagedInstructions(body);
  return `${existingContent.slice(0, markers.start)}${managedSection}${existingContent.slice(markers.end)}`;
}

function renderManagedInstructions(body: string) {
  if (body.includes(MANAGED_INSTRUCTIONS_START) || body.includes(MANAGED_INSTRUCTIONS_END)) {
    throw new MonkeError("Global agent instructions body contains reserved management markers");
  }

  return `${MANAGED_INSTRUCTIONS_START}\n\n${body}${body.endsWith("\n") ? "" : "\n"}${MANAGED_INSTRUCTIONS_END}\n`;
}

function findManagedInstructionMarkers(content: string) {
  const starts = indexesOf(content, MANAGED_INSTRUCTIONS_START);
  const ends = indexesOf(content, MANAGED_INSTRUCTIONS_END);
  const [start] = starts;
  const [endMarker] = ends;
  if (start === undefined && endMarker === undefined) {
    return null;
  }
  if (
    start === undefined ||
    endMarker === undefined ||
    starts.length !== 1 ||
    ends.length !== 1 ||
    start > endMarker
  ) {
    throw new MonkeError("Refusing to modify malformed Global agent instructions markers");
  }

  let end = endMarker + MANAGED_INSTRUCTIONS_END.length;
  if (content.startsWith("\r\n", end)) {
    end += 2;
  } else if (content[end] === "\n") {
    end += 1;
  }
  return { end, start };
}

function indexesOf(content: string, token: string) {
  const indexes: number[] = [];
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(token, offset);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    offset = index + token.length;
  }
  return indexes;
}

function globalInstructionsPath(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions
) {
  if (target.kind === "codex") {
    const configDirectory = resolveAgentConfigDirectory(
      options.environment?.CODEX_HOME,
      options.cwd,
      path.join(options.homeDirectory, ".codex"),
      "CODEX_HOME"
    );
    return path.join(configDirectory, "AGENTS.md");
  }
  if (target.kind === "claude") {
    const configDirectory = resolveAgentConfigDirectory(
      options.environment?.CLAUDE_CONFIG_DIR,
      options.cwd,
      path.join(options.homeDirectory, ".claude"),
      "CLAUDE_CONFIG_DIR"
    );
    return path.join(configDirectory, "CLAUDE.md");
  }

  return null;
}

function resolveAgentConfigDirectory(
  configuredDirectory: string | undefined,
  cwd: string,
  defaultDirectory: string,
  environmentVariable: "CLAUDE_CONFIG_DIR" | "CODEX_HOME"
) {
  if (configuredDirectory === undefined) {
    return defaultDirectory;
  }

  const validDirectory = parseBoundaryValue(
    ConfiguredDirectorySchema,
    configuredDirectory,
    `${environmentVariable} environment variable`
  );
  return path.resolve(cwd, validDirectory);
}

function resolveInstructionFile(destinationPath: string) {
  const destinationStat = lstatSync(destinationPath, { throwIfNoEntry: false });
  if (destinationStat === undefined) {
    return destinationPath;
  }
  if (!destinationStat.isSymbolicLink()) {
    if (!destinationStat.isFile()) {
      throw new MonkeError(
        `Refusing to modify Global agent instructions at ${destinationPath}: destination must be a regular file`
      );
    }
    return destinationPath;
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync.native(destinationPath);
  } catch {
    throw new MonkeError(
      `Refusing to modify Global agent instructions at ${destinationPath}: destination symlink must resolve to a regular file`
    );
  }
  if (!statSync(resolvedPath).isFile()) {
    throw new MonkeError(
      `Refusing to modify Global agent instructions at ${destinationPath}: destination symlink must resolve to a regular file`
    );
  }
  return resolvedPath;
}
