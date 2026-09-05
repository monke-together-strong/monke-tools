import * as z from "zod";

export class MonkeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MonkeError";
  }
}

/** Normalize catch values while preserving Error identity, subclasses, and stacks. */
export const ThrownValueSchema = z.union([z.instanceof(Error), z.unknown().transform(String)]);

export function errorMessage(error: Error | string) {
  return error instanceof Error ? error.message : error;
}
