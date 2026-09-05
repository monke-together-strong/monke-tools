/**
 * Arc-preserving noise-strip (design decision 15). Keep every human + assistant turn in order;
 * collapse each tool call to {name, input_summary, exit_code, error?, output_head_tail}; elide big
 * payloads. No triviality gate.
 */

import type { JsonValue } from "./transcript-schemas.ts";

const INPUT_SUMMARY_MAX = 200;
const OUTPUT_HEAD_TAIL_MAX = 600;
const PROSE_MAX = 4000;

/** One-line summary of a tool's input object or string. */
export function summarizeInput(input: JsonValue | undefined) {
  if (input == null) {
    return "";
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The transcript adapter already validated this recursive JSON value; this selects its string member for readable summaries.
  const text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  return clip(collapseWhitespace(text), INPUT_SUMMARY_MAX);
}

/** Head + tail of tool output; the middle of long output is elided. */
export function summarizeOutput(output: string | undefined) {
  if (output == null) {
    return;
  }
  const trimmed = output.trim();
  if (!trimmed) {
    return;
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
export function clipProse(text: string) {
  return clip(text.trim(), PROSE_MAX);
}

function clip(text: string, max: number) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function collapseWhitespace(text: string) {
  return text.replaceAll(/\s+/gu, " ").trim();
}
