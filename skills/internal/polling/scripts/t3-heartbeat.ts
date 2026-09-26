#!/usr/bin/env bun
// Recurring `[polled]` heartbeat for a Codex thread running inside T3 Code.
// Usage: t3-heartbeat.ts start <minutes> | stop
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import * as z from "zod";

const USERDATA = path.join(process.env.T3CODE_HOME ?? path.join(homedir(), ".t3"), "userdata");
const STATE_DIR = path.join(tmpdir(), "t3-heartbeat");
const TOKEN_TTL = "7d";
const MAX_FAILURES = 5;

const HeartbeatState = z.object({ pid: z.number(), sessionId: z.string() });
const ServerRuntime = z.object({ pid: z.number(), port: z.number() });
const IssuedSession = z.object({ sessionId: z.string(), token: z.string() });
const ThreadRow = z.object({
  active_turn_id: z.string().nullable(),
  interaction_mode: z.string(),
  runtime_mode: z.string()
});
const RpcFrame = z.object({
  _tag: z.string(),
  exit: z.object({ _tag: z.string() }).loose().optional(),
  requestId: z.union([z.string(), z.number()]).optional()
});

function print(line: string) {
  process.stdout.write(`${line}\n`);
}

function db() {
  return new Database(path.join(USERDATA, "state.sqlite"), { readonly: true });
}

async function serverRuntime() {
  return ServerRuntime.parse(await Bun.file(path.join(USERDATA, "server-runtime.json")).json());
}

function currentThreadId() {
  const codexThreadId = process.env.CODEX_THREAD_ID;
  if (codexThreadId === undefined || codexThreadId === "") {
    throw new Error("CODEX_THREAD_ID is not set; run this from a Codex thread.");
  }
  const row = z
    .object({ thread_id: z.string() })
    .nullable()
    .parse(
      db()
        .query(
          "select thread_id from provider_session_runtime where json_extract(resume_cursor_json, '$.threadId') = ?"
        )
        .get(codexThreadId)
    );
  if (!row) {
    throw new Error(`No T3 Code thread found for Codex thread ${codexThreadId}.`);
  }
  return row.thread_id;
}

// Runs the CLI bundled with the running T3 Code app.
async function t3(...args: string[]) {
  const { pid } = await serverRuntime();
  const executable = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  if (executable === "") {
    throw new Error("T3 Code server is not running.");
  }
  const bin = path.join(executable, "../../Resources/app.asar/apps/server/dist/bin.mjs");
  const result = Bun.spawnSync([executable, bin, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  if (result.exitCode !== 0) {
    throw new Error(`t3 ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

const statePath = (threadId: string) => path.join(STATE_DIR, `${threadId}.json`);

async function stop(threadId: string) {
  const file = Bun.file(statePath(threadId));
  if (!(await file.exists())) {
    return false;
  }
  const state = HeartbeatState.parse(await file.json());
  // The PID may have been reused since the loop exited.
  const command = Bun.spawnSync([
    "ps",
    "-o",
    "command=",
    "-p",
    String(state.pid)
  ]).stdout.toString();
  if (command.includes("t3-heartbeat")) {
    try {
      process.kill(state.pid);
    } catch {
      // Already exited.
    }
  }
  await t3("auth", "session", "revoke", state.sessionId).catch(() => "");
  rmSync(statePath(threadId), { force: true });
  return true;
}

// Called by the loop itself when it gives up.
async function cleanUp(threadId: string) {
  await t3("auth", "session", "revoke", process.env.T3_SESSION_ID ?? "").catch(() => "");
  const file = Bun.file(statePath(threadId));
  if ((await file.exists()) && HeartbeatState.parse(await file.json()).pid === process.pid) {
    rmSync(statePath(threadId), { force: true });
  }
}

async function start(minutes: number) {
  if (!(minutes > 0)) {
    throw new Error("minutes must be a positive number.");
  }
  const threadId = currentThreadId();
  await stop(threadId);
  const issued = IssuedSession.parse(
    JSON.parse(
      await t3("auth", "session", "issue", "--ttl", TOKEN_TTL, "--label", "t3-heartbeat", "--json")
    )
  );
  mkdirSync(STATE_DIR, { recursive: true });
  const log = openSync(path.join(STATE_DIR, `${threadId}.log`), "a");
  const child = spawn(process.execPath, [import.meta.path, "loop", threadId, String(minutes)], {
    detached: true,
    env: { ...process.env, T3_SESSION_ID: issued.sessionId, T3_TOKEN: issued.token },
    stdio: ["ignore", log, log]
  });
  child.unref();
  const state = { pid: child.pid ?? 0, sessionId: issued.sessionId };
  await Bun.write(statePath(threadId), JSON.stringify(state));
  print(`Heartbeat every ${minutes}m for T3 thread ${threadId} (pid ${state.pid}).`);
}

async function send(threadId: string) {
  const thread = ThreadRow.nullable().parse(
    db()
      .query(
        `select t.runtime_mode, t.interaction_mode, s.active_turn_id
         from projection_threads t left join projection_thread_sessions s using (thread_id)
         where t.thread_id = ? and t.deleted_at is null`
      )
      .get(threadId)
  );
  if (!thread) {
    throw new Error(`Thread ${threadId} no longer exists.`);
  }
  if (thread.active_turn_id !== null) {
    print(`${new Date().toISOString()} skipped: turn running`);
    return;
  }

  const { port } = await serverRuntime();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: `Bearer ${process.env.T3_TOKEN ?? ""}` }
  });
  const request = {
    _tag: "Request",
    headers: [],
    id: "1",
    payload: {
      commandId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      interactionMode: thread.interaction_mode,
      message: {
        attachments: [],
        messageId: crypto.randomUUID(),
        role: "user",
        text: "[polled]"
      },
      runtimeMode: thread.runtime_mode,
      threadId,
      type: "thread.turn.start"
    },
    tag: "orchestration.dispatchCommand"
  };
  let timer: Timer | undefined;
  const exit = await new Promise<{ _tag: string }>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("No response within 15s."));
    }, 15_000);
    ws.addEventListener("error", () => {
      reject(new Error("WebSocket connection failed."));
    });
    ws.addEventListener("close", () => {
      reject(new Error("Connection closed before a response."));
    });
    ws.addEventListener("message", (event) => {
      const frame = RpcFrame.parse(JSON.parse(String(event.data)));
      if (frame._tag === "Exit" && String(frame.requestId) === "1" && frame.exit) {
        resolve(frame.exit);
      }
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(request));
    });
  }).finally(() => {
    clearTimeout(timer);
    ws.close();
  });
  if (exit._tag !== "Success") {
    throw new Error(`Dispatch failed: ${JSON.stringify(exit)}`);
  }
  print(`${new Date().toISOString()} sent [polled]`);
}

// Failed beats retry after 30s, 60s, 120s, ... (capped at the interval).
async function loop(threadId: string, minutes: number, failures = 0): Promise<void> {
  const interval = minutes * 60_000;
  await Bun.sleep(failures === 0 ? interval : Math.min(15_000 * 2 ** failures, interval));
  let nextFailures = 0;
  try {
    await send(threadId);
  } catch (error) {
    nextFailures = failures + 1;
    process.stderr.write(`${new Date().toISOString()} failure ${nextFailures}: ${String(error)}\n`);
    if (nextFailures >= MAX_FAILURES) {
      await cleanUp(threadId);
      process.exit(1);
    }
  }
  await loop(threadId, minutes, nextFailures);
}

const [command, first, second] = process.argv.slice(2);
if (command === "start") {
  await start(Number(first));
} else if (command === "stop") {
  print((await stop(currentThreadId())) ? "Heartbeat stopped." : "No heartbeat running.");
} else if (command === "loop" && first !== undefined) {
  await loop(first, Number(second));
} else {
  throw new Error("Usage: t3-heartbeat.ts start <minutes> | stop");
}
