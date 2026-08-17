import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { MonkeError } from "./errors.ts";
import type { SkillInstallTargetKind } from "./global-config.ts";

const GLOBAL_INSTRUCTIONS_RELATIVE_PATH = path.join("instructions", "GLOBAL.md");
const MANAGED_INSTRUCTIONS_START = "<!-- monke-tools:global-agent-instructions:start -->";
const MANAGED_INSTRUCTIONS_END = "<!-- monke-tools:global-agent-instructions:end -->";
const MANAGED_INSTRUCTIONS_METADATA_PREFIX = "<!-- monke-tools:global-agent-instructions:metadata ";

const ManagedInstructionsMetadataSchema = z.strictObject({
  createdFile: z.boolean(),
  separatorLength: z.number().int().min(0).max(2)
});
type ManagedInstructionsMetadata = z.output<typeof ManagedInstructionsMetadataSchema>;

interface GlobalInstructionsOptions {
  cwd?: string;
  environment?: Record<string, string | undefined>;
  homeDirectory: string;
}

/** Reconcile the selected harness's Managed instruction section from the source snapshot. */
export function reconcileGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions & { sourceCheckout: string }
) {
  const destinationPath = globalInstructionsPath(target, options);
  if (destinationPath === null) {
    return;
  }

  const filePath = resolveInstructionFile(destinationPath);
  const body = readFileSync(
    path.join(options.sourceCheckout, GLOBAL_INSTRUCTIONS_RELATIVE_PATH),
    "utf-8"
  );
  const existingContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  writeFileSync(
    filePath,
    reconcileManagedInstructions(existingContent, body, target.kind === "codex")
  );
}

/** Remove the selected harness's Managed instruction section without touching user guidance. */
export function removeGlobalInstructions(
  target: { kind: SkillInstallTargetKind },
  options: GlobalInstructionsOptions
) {
  const destinationPath = globalInstructionsPath(target, options);
  if (destinationPath === null) {
    return;
  }
  const destinationStat = lstatIfExists(destinationPath);
  if (destinationStat === null) {
    return;
  }

  const filePath = resolveInstructionFile(destinationPath);
  const existingContent = readFileSync(filePath, "utf-8");
  const markers = findManagedInstructionMarkers(existingContent);
  if (markers === null) {
    return;
  }

  const managedStart = markers.start - markers.metadata.separatorLength;
  if (
    managedStart < 0 ||
    existingContent.slice(managedStart, markers.start) !==
      "\n".repeat(markers.metadata.separatorLength)
  ) {
    throw new MonkeError("Refusing to modify malformed Global agent instructions metadata");
  }
  const before = existingContent.slice(0, managedStart);
  const after = existingContent.slice(markers.end);
  const nextContent = `${before}${after}`;
  if (nextContent.length === 0) {
    if (destinationStat.isSymbolicLink() || !markers.metadata.createdFile) {
      writeFileSync(filePath, "");
    } else {
      rmSync(filePath);
    }
    return;
  }
  writeFileSync(filePath, nextContent);
}

function reconcileManagedInstructions(
  existingContent: string | null,
  body: string,
  adoptWholeFileMatch: boolean
) {
  if (existingContent === null) {
    return renderManagedInstructions(body, { createdFile: true, separatorLength: 0 });
  }
  if (existingContent.length === 0) {
    return renderManagedInstructions(body, { createdFile: false, separatorLength: 0 });
  }
  if (adoptWholeFileMatch && existingContent === body) {
    return renderManagedInstructions(body, { createdFile: false, separatorLength: 0 });
  }

  const markers = findManagedInstructionMarkers(existingContent);
  if (markers === null) {
    let separator = "\n\n";
    if (existingContent.endsWith("\n\n")) {
      separator = "";
    } else if (existingContent.endsWith("\n")) {
      separator = "\n";
    }
    const managedSection = renderManagedInstructions(body, {
      createdFile: false,
      separatorLength: separator.length
    });
    return `${existingContent}${separator}${managedSection}`;
  }

  const managedSection = renderManagedInstructions(body, markers.metadata);
  return `${existingContent.slice(0, markers.start)}${managedSection}${existingContent.slice(markers.end)}`;
}

function renderManagedInstructions(body: string, metadata: ManagedInstructionsMetadata) {
  if (body.includes(MANAGED_INSTRUCTIONS_START) || body.includes(MANAGED_INSTRUCTIONS_END)) {
    throw new MonkeError("Global agent instructions body contains reserved management markers");
  }

  const metadataComment = `${MANAGED_INSTRUCTIONS_METADATA_PREFIX}${JSON.stringify(metadata)} -->`;
  return `${MANAGED_INSTRUCTIONS_START}\n${metadataComment}\n${body}${body.endsWith("\n") ? "" : "\n"}${MANAGED_INSTRUCTIONS_END}\n`;
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

  const metadataStart = start + MANAGED_INSTRUCTIONS_START.length + 1;
  const metadataEnd = content.indexOf("\n", metadataStart);
  if (
    content[start + MANAGED_INSTRUCTIONS_START.length] !== "\n" ||
    metadataEnd === -1 ||
    metadataEnd > endMarker
  ) {
    throw new MonkeError("Refusing to modify malformed Global agent instructions metadata");
  }
  const metadata = parseManagedInstructionsMetadata(content.slice(metadataStart, metadataEnd));

  let end = endMarker + MANAGED_INSTRUCTIONS_END.length;
  if (content[end] === "\n") {
    end += 1;
  }
  return { end, metadata, start };
}

function parseManagedInstructionsMetadata(comment: string) {
  if (!comment.startsWith(MANAGED_INSTRUCTIONS_METADATA_PREFIX) || !comment.endsWith(" -->")) {
    throw new MonkeError("Refusing to modify malformed Global agent instructions metadata");
  }

  let value: unknown;
  try {
    value = JSON.parse(comment.slice(MANAGED_INSTRUCTIONS_METADATA_PREFIX.length, -4));
  } catch {
    throw new MonkeError("Refusing to modify malformed Global agent instructions metadata");
  }
  const parsed = ManagedInstructionsMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new MonkeError("Refusing to modify malformed Global agent instructions metadata");
  }

  return parsed.data;
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
      path.join(options.homeDirectory, ".codex")
    );
    return path.join(configDirectory, "AGENTS.md");
  }
  if (target.kind === "claude") {
    const configDirectory = resolveAgentConfigDirectory(
      options.environment?.CLAUDE_CONFIG_DIR,
      options.cwd,
      path.join(options.homeDirectory, ".claude")
    );
    return path.join(configDirectory, "CLAUDE.md");
  }

  return null;
}

function resolveAgentConfigDirectory(
  configuredDirectory: string | undefined,
  cwd: string | undefined,
  defaultDirectory: string
) {
  if (configuredDirectory === undefined) {
    return defaultDirectory;
  }

  return path.resolve(cwd ?? process.cwd(), configuredDirectory);
}

function resolveInstructionFile(destinationPath: string) {
  const destinationStat = lstatIfExists(destinationPath);
  if (destinationStat === null) {
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

function lstatIfExists(targetPath: string) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
