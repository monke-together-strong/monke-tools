/** Compute one SHA-256 digest with Bun's native cryptographic hasher. */
export function sha256(value: Bun.BlobOrStringOrBuffer) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** Compute one SHA-256 digest without buffering the file in memory. */
export async function sha256File(filePath: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(filePath).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}
