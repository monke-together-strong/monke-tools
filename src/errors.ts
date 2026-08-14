export class MonkeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonkeError";
  }
}

/** Read a displayable message off an unknown thrown value. */
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
