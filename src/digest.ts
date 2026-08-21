import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Return the lowercase SHA-256 digest of bytes or text. */
export function sha256(contents: string | Uint8Array) {
  return createHash("sha256").update(contents).digest("hex");
}

/** Return the lowercase SHA-256 digest of one file. */
export function sha256File(filePath: string) {
  return sha256(readFileSync(filePath));
}
