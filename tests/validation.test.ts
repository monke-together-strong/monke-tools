import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { errorMessage, MonkeError, ThrownValueSchema } from "../src/errors.ts";
import { parseOwnedYamlText } from "../src/validation.ts";

describe("boundary validation", () => {
  it("preserves error identity and safely represents non-errors in catch normalization", () => {
    const error = new MonkeError("failed", { cause: new Error("original") });
    expect(ThrownValueSchema.parse(error)).toBe(error);
    expect(errorMessage(ThrownValueSchema.parse(error))).toBe("failed");
    expect(errorMessage(ThrownValueSchema.parse(null))).toBe("null");
    expect(errorMessage(ThrownValueSchema.parse({ reason: "failed" }))).toBe("[object Object]");
  });

  it("distinguishes array indexes from numeric property names in validation paths", () => {
    const schema = z.object({ entries: z.array(z.object({ "0": z.string() })) });
    expect(() => parseOwnedYamlText('entries: [{"0": 42}]', "fixture", schema)).toThrow(
      /entries\[0\]\.0: /u
    );
  });
});
