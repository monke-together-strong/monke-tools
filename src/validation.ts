import { readFileSync } from "node:fs";

import { parseDocument } from "yaml";
import type * as z from "zod";

import { MonkeError } from "./errors.ts";

/** Parse an application-owned YAML file and validate its runtime shape. */
export function parseOwnedYamlFile<T extends z.ZodType>(filePath: string, schema: T) {
  return parseOwnedYamlText(readFileSync(filePath, "utf-8"), filePath, schema);
}

/** Parse application-owned YAML text and validate its runtime shape. */
export function parseOwnedYamlText<T extends z.ZodType>(text: string, label: string, schema: T) {
  const document = parseDocument(text, {
    merge: false,
    strict: true,
    uniqueKeys: true
  });

  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join("\n");
    throw new MonkeError(`Invalid ${label}:\n${message}`);
  }

  const value: unknown = document.toJS();
  return parseBoundaryValue(schema, value, label);
}

/** Validate one runtime boundary and translate schema issues into application errors. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This shared boundary parser validates the value before returning it.
export function parseBoundaryValue<T extends z.ZodType>(schema: T, value: unknown, label: string) {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const message = result.error.issues
    .map((issue) => {
      const location = formatIssuePath(issue.path);
      return location ? `${location}: ${issue.message}` : issue.message;
    })
    .join("\n");
  throw new MonkeError(`Invalid ${label}:\n${message}`);
}

function formatIssuePath(issuePath: PropertyKey[]) {
  let result = "";
  for (const segment of issuePath) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Zod supplies these typed issue-path segments; this only formats numeric indexes.
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else {
      result += result ? `.${String(segment)}` : String(segment);
    }
  }
  return result;
}
