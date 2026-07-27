/**
 * Arc-preserving noise-strip (design decision 15). Keep every human + assistant
 * turn in order; collapse each tool call to {name, input_summary, exit_code,
 * error?, output_head_tail}; elide big payloads. No triviality gate.
 */

const INPUT_SUMMARY_MAX = 200;
const OUTPUT_HEAD_TAIL_MAX = 600;
const PROSE_MAX = 4000;

/** One-line summary of a tool's input object or string. */
export function summarizeInput(input: unknown): string {
  if (input == null) {
    return "";
  }
  const text = typeof input === "string" ? input : safeStringify(input);
  return clip(collapseWhitespace(text), INPUT_SUMMARY_MAX);
}

/** Head + tail of tool output; the middle of long output is elided. */
export function summarizeOutput(output: unknown): string | undefined {
  if (output == null) {
    return undefined;
  }
  const text = typeof output === "string" ? output : safeStringify(output);
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= OUTPUT_HEAD_TAIL_MAX) {
    return trimmed;
  }
  const half = Math.floor(OUTPUT_HEAD_TAIL_MAX / 2);
  const head = trimmed.slice(0, half);
  const tail = trimmed.slice(-half);
  const elided = trimmed.length - OUTPUT_HEAD_TAIL_MAX;
  return `${head}\n… [${elided} chars elided] …\n${tail}`;
}

/** Keep assistant/human prose, but cap pathological lengths. */
export function clipProse(text: string): string {
  return clip(text.trim(), PROSE_MAX);
}

/** Collapse a file-read tool result to {path, size} when the body is large. */
export function elideFilePayload(filePath: string, body: string): string {
  if (body.length <= OUTPUT_HEAD_TAIL_MAX) {
    return body.trim();
  }
  return `{path: ${filePath}, size: ${body.length} chars}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
