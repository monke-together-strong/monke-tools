import { describe, expect, it } from "vite-plus/test";

import { runReleaseCommand } from "../src/release-command.ts";
import { createRuntime } from "../src/runtime.ts";

describe(runReleaseCommand, () => {
  it("returns stdout from a successful command", () => {
    expect(runReleaseCommand("sh", ["-c", "printf result"])).toBe("result");
  });

  it("reports stderr from a nonzero command", () => {
    expect(() => runReleaseCommand("sh", ["-c", "printf failure >&2; exit 7"])).toThrow(
      "sh -c printf failure >&2; exit 7 failed: failure"
    );
  });

  it("reports when an executable cannot be started", () => {
    expect(() => runReleaseCommand("definitely-missing-monke-command", [])).toThrow(
      "definitely-missing-monke-command could not be started"
    );
  });

  it.skipIf(process.platform === "win32")("reports signal termination", () => {
    expect(() => runReleaseCommand("sh", ["-c", "kill -TERM $$"])).toThrow(
      "terminated by signal SIGTERM"
    );
  });

  it.skipIf(process.platform === "win32")("reports signal termination through a runtime", () => {
    const { exec } = createRuntime();

    expect(() => runReleaseCommand("sh", ["-c", "kill -TERM $$"], { exec })).toThrow(
      "terminated by signal SIGTERM"
    );
  });
});
