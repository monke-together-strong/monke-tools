/** Quote one literal argument for POSIX-compatible shells. */
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
