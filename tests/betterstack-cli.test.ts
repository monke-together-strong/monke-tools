import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { loadEnvFileIfPresent } from "../skills/internal/betterstack-cli/scripts/betterstack-cli/env.ts";
import { makeTempDir } from "./helpers.ts";

const cliPath = path.resolve(
  import.meta.dirname,
  "../skills/internal/betterstack-cli/scripts/betterstack-cli/index.ts"
);

describe("Better Stack content I/O", () => {
  it.each(["explicit", "variable", "demo"])(
    "Better Stack loads %s env credentials before sending SQL file contents",
    async (selection) => {
      const directory = makeTempDir("betterstack-content-io");
      const envFile = path.join(directory, selection === "demo" ? ".env.demo" : "query.env");
      const sqlFile = path.join(directory, "query.sql");
      const preloadFile = path.join(directory, "capture-fetch.ts");
      const sql = "\uFEFFSELECT 'banana 🍌'\r\nFROM logs\n";
      await Promise.all([
        Bun.write(
          envFile,
          [
            "# Query credentials",
            "export BETTERSTACK_QUERY_URL='https://test-connect.betterstackdata.com'",
            'BETTERSTACK_QUERY_USERNAME="file-user"',
            'BETTERSTACK_QUERY_PASSWORD="file-password"',
            ""
          ].join("\r\n")
        ),
        Bun.write(sqlFile, sql),
        Bun.write(
          preloadFile,
          `globalThis.fetch = async (url, options) => new Response(JSON.stringify({
          authorization: options.headers.Authorization,
          method: options.method,
          sql: options.body,
          url
        }));`
        )
      ]);

      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preloadFile,
          cliPath,
          "query",
          "run",
          "--source-id",
          "1",
          "--table",
          "logs",
          "--sql-file",
          sqlFile,
          ...(selection === "explicit" ? ["--env-file", envFile] : [])
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            BETTER_STACK_TOKEN: "",
            BETTERSTACK_API_TOKEN: "",
            BETTERSTACK_ENV_FILE:
              selection === "variable"
                ? envFile
                : selection === "explicit"
                  ? path.join(directory, "unused.env")
                  : undefined,
            BETTERSTACK_QUERY_PASSWORD: undefined,
            BETTERSTACK_QUERY_URL: undefined,
            BETTERSTACK_QUERY_USERNAME: "inherited-user"
          },
          stderr: "pipe",
          stdout: "pipe"
        }
      );

      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ]);

      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toStrictEqual({
        authorization: `Basic ${Buffer.from("inherited-user:file-password").toString("base64")}`,
        method: "POST",
        sql,
        url: "https://test-connect.betterstackdata.com"
      });
    }
  );

  it("Better Stack ignores missing env files and propagates other read errors", async () => {
    const directory = makeTempDir("betterstack-env-read-errors");
    await expect(
      loadEnvFileIfPresent(path.join(directory, "missing.env"))
    ).resolves.toBeUndefined();
    await expect(loadEnvFileIfPresent(directory)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
