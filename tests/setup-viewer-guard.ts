import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vite-plus/test";

// A timed-out test can outlive its fixture's viewer shims. Block PATH lookup from reaching the
// developer's real Codiff or Monke See after the fixture directory is removed.
const guardDirectory = mkdtempSync(path.join(tmpdir(), "monke-test-viewer-guard-"));

for (const viewer of ["codiff", "ms"]) {
  const executable = path.join(guardDirectory, viewer);
  writeFileSync(
    executable,
    `#!/bin/sh\necho "test reached the real ${viewer}: its fake is missing from PATH" >&2\nexit 97\n`
  );
  chmodSync(executable, 0o755);
}

process.env.PATH = [guardDirectory, process.env.PATH].filter(Boolean).join(path.delimiter);

afterAll(() => {
  rmSync(guardDirectory, { force: true, recursive: true });
});
