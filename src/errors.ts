export class MonkeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MonkeError";
  }
}

/** Read a displayable message off an unknown thrown value. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript catch values are untyped at this boundary.
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
