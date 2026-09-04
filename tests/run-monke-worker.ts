// SAFETY: The parent test process sets this from its NodeJS.Platform-valued process.platform.
const platform = process.env.MONKE_TEST_PLATFORM as NodeJS.Platform | undefined;
if (platform !== undefined) {
  Object.defineProperty(process, "platform", { value: platform });
}

const [{ runCliAsync }, { createRuntime }] = await Promise.all([
  import("../src/index.ts"),
  import("../src/runtime.ts")
]);

try {
  await runCliAsync(
    Bun.argv.slice(2),
    createRuntime({
      platform,
      sessionMaterializationBoundary(checkpoint) {
        if (checkpoint === process.env.MONKE_TEST_INTERRUPT_CHECKPOINT) {
          process.kill(process.pid, "SIGKILL");
        }
      }
    })
  );
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "Monke command failed");
  process.exitCode = 1;
}
