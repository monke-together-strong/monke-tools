import { pathToFileURL } from "node:url";

// oxlint-disable anti-slop/no-runtime-typeof -- This isolated process validates arbitrary repo-owned modules without depending on mt's libraries.

// Embedded as source and evaluated by the repo's Bun runtime, not executed by mt itself.
const [, runnerArgv, modulePath, outputPath] = process.argv;

try {
  if (runnerArgv !== "monke-resource-command-runner" || !modulePath || !outputPath) {
    throw new Error("Missing resource command runner arguments");
  }
  const previousText = await Bun.stdin.text();
  const previous: unknown = previousText.trim() ? JSON.parse(previousText) : {};
  const resourceModule: unknown = await import(pathToFileURL(modulePath).href);
  if (
    typeof resourceModule !== "object" ||
    resourceModule === null ||
    !("default" in resourceModule)
  ) {
    throw new Error(`Resource command module ${modulePath} must export a default function`);
  }
  if (typeof resourceModule.default !== "function") {
    throw new TypeError(`Resource command module ${modulePath} default export must be a function`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-call -- The repo-owned export is callable above; its result stays unknown until the parent validates the output contract.
  const value: unknown = await resourceModule.default({ previous });
  await Bun.write(outputPath, JSON.stringify({ value }));
} catch (error) {
  await Bun.write(
    Bun.stderr,
    `${error instanceof Error && error.stack ? error.stack : String(error)}\n`
  );
  process.exit(1);
}
