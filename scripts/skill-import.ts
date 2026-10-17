import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import is from "@sindresorhus/is";
import pc from "picocolors";
import * as z from "zod";

import { MonkeError } from "../src/errors.ts";
import type { StagedSkillSelection } from "./skill-import-recipes.ts";
import { buildSkillsInstallArgs, listStagedSkillSlugs, runSkillsCaptured } from "./skills-cli.ts";

export interface SecurityRiskAssessment {
  detailsUrl: string | null;
  rows: SecurityRiskRow[];
}

interface SecurityRiskRow {
  gen: string;
  skillName: string;
  snyk: string;
  socket: string;
}

const CSI_RE = new RegExp(
  String.raw`\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]`,
  "gu"
);

const OSC_RE = new RegExp(String.raw`\u001b\][\s\S]*?(?:\u0007|\u001b\\)`, "gu");
const DCS_PM_APC_RE = new RegExp(String.raw`\u001b[P^_][\s\S]*?(?:\u001b\\)`, "gu");
const SIMPLE_ESC_RE = new RegExp(String.raw`\u001b[\u0020-\u007e]`, "gu");
const C1_RE = new RegExp(String.raw`[\u0080-\u009f]`, "gu");

const CONTROL_RE = new RegExp(
  String.raw`[\u0000-\u0006\u0007\u0008\u000b\u000c\u000d-\u001a\u001c-\u001f\u007f]`,
  "gu"
);

/** Options for resolving exact selector-to-slug mappings with isolated installs. */
export interface ResolveSkillSelectorSlugMappingsOptions {
  /** Upstream Skill import selectors to install one at a time. */
  selectors: readonly string[];
  /** Source string passed through to upstream `skills add`. */
  source: string;
}

/** Extracts and renders the upstream security assessment from noisy install output. */
export function extractSecurityRiskAssessment(output: string) {
  const assessment = parseSecurityRiskAssessment(output);

  if (!assessment) {
    return null;
  }

  return renderSecurityRiskAssessment(assessment);
}

/** Writes a non-empty upstream security assessment when one is present. */
export function reportSecurityRiskAssessment(
  output: string | readonly SecurityRiskAssessment[],
  writeMessage: (message: string) => void
) {
  const assessment = is.string(output)
    ? extractSecurityRiskAssessment(output)
    : renderSecurityRiskAssessments(output);

  if (assessment) {
    writeMessage(assessment);
  }
}

/** Reads optional importer assessments keyed by lowercase selector. Ignores invalid output. */
export function readJsonSecurityRiskAssessments(output: string) {
  const assessments = new Map<string, SecurityRiskAssessment>();

  const schema = z.array(
    z.looseObject({
      name: z.string(),
      security: z
        .looseObject({
          details: z.string().optional(),
          gen: z.string().optional(),
          snyk: z.string().optional(),
          socket: z.string().optional()
        })
        .nullish(),
      status: z.string()
    })
  );

  try {
    const value: unknown = JSON.parse(output);
    const parsed = schema.safeParse(value);

    if (parsed.success) {
      for (const result of parsed.data) {
        if (result.status === "installed" && result.security) {
          assessments.set(result.name.toLowerCase(), {
            detailsUrl: result.security.details ?? null,
            rows: [
              {
                gen: jsonRiskLabel(result.security.gen),
                skillName: result.name,
                snyk: jsonRiskLabel(result.security.snyk),
                socket: result.security.socket ?? "--"
              }
            ]
          });
        }
      }
    }
  } catch {
    return assessments;
  }

  return assessments;
}

/** Combines selected assessments into one report, or returns an empty string when none exist. */
function renderSecurityRiskAssessments(assessments: readonly SecurityRiskAssessment[]) {
  if (assessments.length === 0) {
    return "";
  }

  return renderSecurityRiskAssessment({
    detailsUrl: assessments.find((assessment) => assessment.detailsUrl)?.detailsUrl ?? null,
    rows: assessments.flatMap((assessment) => assessment.rows)
  });
}

function jsonRiskLabel(value: string | undefined) {
  switch (value ?? "") {
    case "critical": {
      return "Critical Risk";
    }

    case "high": {
      return "High Risk";
    }

    case "medium": {
      return "Med Risk";
    }

    case "low": {
      return "Low Risk";
    }

    case "safe": {
      return "Safe";
    }

    default: {
      return "--";
    }
  }
}

/** Parses upstream security assessment rows from install output. */
function parseSecurityRiskAssessment(output: string) {
  const rawLines = output.split(/\r?\n/u);
  const strippedLines = rawLines.map(stripTerminalEscapes);
  const startIndex = strippedLines.findIndex((line) => line.includes("Security Risk Assessments"));

  if (startIndex === -1) {
    return null;
  }

  const rows: SecurityRiskRow[] = [];
  let detailsUrl: string | null = null;

  for (let index = startIndex + 1; index < strippedLines.length; index += 1) {
    const rawLine = strippedLines[index];

    if (rawLine === undefined) {
      continue;
    }

    const line = cleanSecurityRiskAssessmentLine(rawLine);

    if (
      line.includes("Installation complete") ||
      line.includes("Installed ") ||
      line.startsWith("Done!")
    ) {
      break;
    }

    if (!line || line.includes("Gen") || line.includes("Socket") || line.includes("Snyk")) {
      continue;
    }

    if (line.startsWith("Details:")) {
      detailsUrl = line.slice("Details:".length).trim() || null;
      continue;
    }

    const row = parseSecurityRiskRow(line);

    if (row) {
      rows.push(row);
    }
  }

  if (rows.length === 0 && !detailsUrl) {
    return null;
  }

  return {
    detailsUrl,
    rows
  };
}

function renderSecurityRiskAssessment(assessment: SecurityRiskAssessment) {
  const skillWidth = Math.max(
    "Skill".length,
    ...assessment.rows.map((row) => row.skillName.length)
  );

  const genWidth = Math.max("Gen".length, ...assessment.rows.map((row) => row.gen.length), 8);

  const socketWidth = Math.max(
    "Socket".length,
    ...assessment.rows.map((row) => row.socket.length),
    12
  );

  const snykWidth = Math.max("Snyk".length, ...assessment.rows.map((row) => row.snyk.length), 8);

  const bodyLines = [
    [
      " ".repeat(skillWidth + 2),
      pc.dim(padEndVisible("Gen", genWidth + 2)),
      pc.dim(padEndVisible("Socket", socketWidth + 2)),
      pc.dim(padEndVisible("Snyk", snykWidth))
    ].join(""),
    ...assessment.rows.map((row) =>
      [
        padEndVisible(pc.cyan(row.skillName), skillWidth + 2),
        padEndVisible(riskValueLabel(row.gen), genWidth + 2),
        padEndVisible(socketValueLabel(row.socket), socketWidth + 2),
        padEndVisible(riskValueLabel(row.snyk), snykWidth)
      ].join("")
    )
  ];

  if (assessment.detailsUrl) {
    bodyLines.push("", `${pc.dim("Details:")} ${pc.dim(assessment.detailsUrl)}`);
  }

  return renderNoteBox("Security Risk Assessments", bodyLines);
}

function parseSecurityRiskRow(line: string) {
  const wideParts = line.split(/\s{2,}/u).filter(Boolean);

  if (wideParts.length >= 4) {
    const [skillName, gen, socket, snyk] = wideParts;

    if (
      skillName === undefined ||
      gen === undefined ||
      socket === undefined ||
      snyk === undefined
    ) {
      return null;
    }

    return {
      gen,
      skillName,
      snyk,
      socket
    };
  }

  const riskPattern = "(?:Critical Risk|High Risk|Med Risk|Low Risk|Safe|--)";

  const rowPattern = new RegExp(
    `^(\\S+)\\s+(${riskPattern})\\s+((?:\\d+ alerts?)|--)\\s+(${riskPattern})$`,
    "u"
  );

  const match = line.match(rowPattern);

  if (!match) {
    return null;
  }

  const [, skillName = "", gen = "", socket = "", snyk = ""] = match;

  return {
    gen,
    skillName,
    snyk,
    socket
  };
}

function cleanSecurityRiskAssessmentLine(line: string) {
  let cleaned = line.trim();

  if (cleaned.startsWith("\u2502")) {
    cleaned = cleaned.slice(1).trimEnd();
  }

  if (cleaned.endsWith("\u2502")) {
    cleaned = cleaned.slice(0, -1).trimEnd();
  }

  return cleaned.trim();
}

function renderNoteBox(title: string, bodyLines: string[]) {
  const contentWidth = Math.max(
    visibleLength(title) + 2,
    ...bodyLines.map((line) => visibleLength(line))
  );

  const titlePrefix = `${pc.green("\u25C7")}  ${title} `;
  const topRuleWidth = Math.max(1, contentWidth - visibleLength(title) - 1);

  const lines = [
    `${titlePrefix}${pc.dim("\u2500".repeat(topRuleWidth))}${pc.dim("\u256E")}`,
    ...bodyLines.map((line) => {
      const padding = " ".repeat(contentWidth - visibleLength(line));

      return `${pc.dim("\u2502")} ${line}${padding} ${pc.dim("\u2502")}`;
    }),
    `${pc.dim("\u2570")}${pc.dim("\u2500".repeat(contentWidth + 2))}${pc.dim("\u256F")}`
  ];

  return `${lines.join("\n")}\n`;
}

function riskValueLabel(value: string) {
  switch (value.toLowerCase()) {
    case "safe":
    case "low risk": {
      return pc.green(value);
    }

    case "med risk": {
      return pc.yellow(value);
    }

    case "high risk":
    case "critical risk": {
      return pc.red(value);
    }

    case "--": {
      return pc.dim(value);
    }

    default: {
      return value;
    }
  }
}

function socketValueLabel(value: string) {
  if (value === "--") {
    return pc.dim(value);
  }

  if (value.startsWith("0 ")) {
    return pc.green(value);
  }

  return pc.red(value);
}

function padEndVisible(value: string, width: number) {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function visibleLength(value: string) {
  return stripTerminalEscapes(value).length;
}

/** Resolves exact selector-to-local-slug mappings by staging each selector in isolation. */
export function resolveSkillSelectorSlugMappings(options: ResolveSkillSelectorSlugMappingsOptions) {
  if (options.selectors.length === 0) {
    throw new MonkeError("At least one Skill import selector must be selected");
  }

  return options.selectors.map((selector) => resolveSkillSelectorSlugMapping(options, selector));
}

function resolveSkillSelectorSlugMapping(
  options: ResolveSkillSelectorSlugMappingsOptions,
  selector: string
) {
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-selector-"));

  try {
    runSkillsCaptured(
      buildSkillsInstallArgs({
        selectors: [selector],
        source: options.source
      }),
      stagingDirectory
    );

    const stagedSlugs = listStagedSkillSlugs(stagingDirectory);

    if (stagedSlugs.length !== 1) {
      throw new MonkeError(
        `Expected selector ${selector} from ${options.source} to stage exactly one Skill, but staged ${stagedSlugs.join(", ")}`
      );
    }

    const [slug] = stagedSlugs;

    if (slug === undefined) {
      throw new MonkeError(`Expected selector ${selector} to resolve to one staged Skill`);
    }

    return { selector, slug };
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

/** Ensures isolated selector installs match the batched staged install result. */
export function assertSkillSelectorSlugMappingsMatchStagedSlugs(
  source: string,
  mappings: readonly StagedSkillSelection[],
  stagedSlugs: readonly string[]
) {
  const mappedSlugs = mappings.map((mapping) => mapping.slug).toSorted();
  const sortedStagedSlugs = [...stagedSlugs].toSorted();

  if (
    mappedSlugs.length !== sortedStagedSlugs.length ||
    mappedSlugs.some((slug, index) => slug !== sortedStagedSlugs[index])
  ) {
    throw new MonkeError(
      [
        `Could not map selected Skill import selectors to staged Skill slugs for ${source}.`,
        `Mapped slugs: ${mappedSlugs.join(", ")}`,
        `Staged slugs: ${sortedStagedSlugs.join(", ")}`
      ].join("\n")
    );
  }
}

export function sanitizeSkillMetadata(value: string) {
  return stripTerminalEscapes(value)
    .replaceAll(/[\r\n]+/gu, " ")
    .trim();
}

function stripTerminalEscapes(value: string) {
  return value
    .replace(OSC_RE, "")
    .replace(DCS_PM_APC_RE, "")
    .replace(CSI_RE, "")
    .replace(SIMPLE_ESC_RE, "")
    .replace(C1_RE, "")
    .replace(CONTROL_RE, "");
}
