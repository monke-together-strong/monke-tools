import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import type * as z from "zod";

import { MonkeError } from "./errors.ts";

/** Parse an application-owned YAML file and validate its runtime shape. */
export function parseOwnedYamlFile<T extends z.ZodType>(filePath: string, schema: T): z.output<T> {
  return parseOwnedYamlText(readFileSync(filePath, "utf8"), filePath, schema);
}

/** Parse application-owned YAML text and validate its runtime shape. */
export function parseOwnedYamlText<T extends z.ZodType>(
  text: string,
  label: string,
  schema: T,
): z.output<T> {
  const document = parseDocument(text, {
    uniqueKeys: true,
    merge: false,
    strict: true,
  });

  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join("\n");
    throw new MonkeError(`Invalid ${label}:\n${message}`);
  }

  return parseBoundaryValue(schema, document.toJS() as unknown, label);
}

/** Validate one runtime boundary and translate schema issues into application errors. */
export function parseBoundaryValue<T extends z.ZodType>(
  schema: T,
  value: unknown,
  label: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const message = result.error.issues
    .map((issue) => {
      const location = formatIssuePath(issue.path);
      if (issue.code === "unrecognized_keys") {
        const suffix = location ? ` at ${location}` : "";
        return issue.keys.map((key) => `Unknown key ${key}${suffix}`).join("\n");
      }
      if (location && issue.message.startsWith("must ")) {
        return `${location} ${issue.message}`;
      }
      return location ? `${location}: ${issue.message}` : issue.message;
    })
    .join("\n");
  throw new MonkeError(`Invalid ${label}:\n${message}`);
}

function formatIssuePath(issuePath: PropertyKey[]): string {
  let result = "";
  for (const segment of issuePath) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else {
      result += result ? `.${String(segment)}` : String(segment);
    }
  }
  return result;
}
