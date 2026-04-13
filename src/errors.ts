export class MonkeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonkeError";
  }
}
