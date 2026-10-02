import { describe, expect, test } from "vite-plus/test";

import { runReleaseCommand } from "../src/release-command.ts";

describe(runReleaseCommand, () => {
  test("returns stdout from a successful command", () => {
    expect(runReleaseCommand("sh", ["-c", "printf result"])).toBe("result");
  });

  test("reports stderr from a nonzero command", () => {
    expect(() => runReleaseCommand("sh", ["-c", "printf failure >&2; exit 7"])).toThrow(
      "sh -c printf failure >&2; exit 7 failed: failure"
    );
  });

  test("reports when an executable cannot be started", () => {
    expect(() => runReleaseCommand("definitely-missing-monke-command", [])).toThrow(
      "definitely-missing-monke-command could not be started"
    );
  });

  test.skipIf(process.platform === "win32")("reports signal termination", () => {
    expect(() => runReleaseCommand("sh", ["-c", "kill -TERM $$"])).toThrow(
      "terminated by signal SIGTERM"
    );
  });
});
