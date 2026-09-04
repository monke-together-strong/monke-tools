import { describe, expect, test } from "vitest";

import { sha256 } from "../src/sha256.ts";

describe(sha256, () => {
  test("returns the standard SHA-256 digest", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
