import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { findExecutable, getHomeDirectory, getMonkeHome } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const LAUNCHD_LABEL = "com.monke-together-strong.mt-prs-poll";
const SYSTEMD_UNIT = "mt-prs-poll";
const POLL_INTERVAL_MINUTES = 5;

interface PollJob {
  /** Absolute paths of the files that define the job; the first one marks it as installed. */
  files: Record<string, string>;
  load: () => void;
  /** Unloads the job. A launchd job that runs this on itself is stopped, so call it last. */
  unload: () => void;
}

/** Schedule `mt prs poll` every five minutes unless it is already scheduled. */
export function schedulePoll(runtime: Runtime) {
  const mt = findExecutable("mt", runtime.env);

  if (mt === null) {
    throw new MonkeError("Cannot schedule mt prs poll: mt was not found on PATH");
  }

  const job = pollJob(runtime, mt);

  if (job === undefined) {
    runtime.writeStderr(`mt prs poll is not scheduled on ${runtime.platform}; run it yourself.\n`);

    return;
  }

  const [marker] = Object.keys(job.files);

  if (marker === undefined || existsSync(marker)) {
    return;
  }

  mkdirSync(path.dirname(pollLogPath(runtime)), { recursive: true });

  try {
    for (const [file, contents] of Object.entries(job.files)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }

    job.load();
  } catch (cause) {
    // Leave no marker behind, so the next `track` retries the install.
    for (const file of Object.keys(job.files)) {
      rmSync(file, { force: true });
    }

    throw cause;
  }
}

/** Remove the scheduled poll, such as when no PR is tracked. */
export function unschedulePoll(runtime: Runtime) {
  const job = pollJob(runtime, "mt");
  const [marker] = Object.keys(job?.files ?? {});

  if (job === undefined || marker === undefined || !existsSync(marker)) {
    return;
  }

  for (const file of Object.keys(job.files)) {
    rmSync(file, { force: true });
  }

  job.unload();
}

function pollJob(runtime: Runtime, mt: string): PollJob | undefined {
  if (runtime.platform !== "darwin" && runtime.platform !== "linux") {
    return undefined;
  }

  // Scheduled jobs start with a bare environment, so carry the PATH that finds gh and t3.
  const environment = {
    PATH: runtime.env.PATH ?? "",
    ...(runtime.env.MONKE_HOME === undefined ? {} : { MONKE_HOME: getMonkeHome(runtime) })
  };

  return runtime.platform === "darwin"
    ? launchdJob(runtime, mt, environment)
    : systemdJob(runtime, mt, environment);
}

function launchdJob(runtime: Runtime, mt: string, environment: Record<string, string>): PollJob {
  const plist = path.join(
    getHomeDirectory(runtime),
    "Library",
    "LaunchAgents",
    `${LAUNCHD_LABEL}.plist`
  );

  const domain = `gui/${process.getuid?.() ?? 0}`;

  return {
    files: { [plist]: launchdPlist(mt, environment, pollLogPath(runtime)) },
    load: () => {
      runtime.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { allowFailure: true });
      runtime.exec("launchctl", ["bootstrap", domain, plist]);
    },
    unload: () => {
      runtime.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { allowFailure: true });
    }
  };
}

function launchdPlist(mt: string, environment: Record<string, string>, log: string) {
  const variables = Object.entries(environment)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");

  // AbandonProcessGroup lets the final `launchctl bootout` finish when the poll unloads itself.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(mt)}</string>
    <string>prs</string>
    <string>poll</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>StartInterval</key>
  <integer>${POLL_INTERVAL_MINUTES * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function systemdJob(runtime: Runtime, mt: string, environment: Record<string, string>): PollJob {
  const units = path.join(
    runtime.env.XDG_CONFIG_HOME ?? path.join(getHomeDirectory(runtime), ".config"),
    "systemd",
    "user"
  );

  const log = pollLogPath(runtime);
  const timer = `${SYSTEMD_UNIT}.timer`;

  const variables = Object.entries(environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");

  return {
    files: {
      [path.join(units, `${SYSTEMD_UNIT}.service`)]: `[Unit]
Description=Hand externally merged PRs back to their T3 Code threads

[Service]
Type=oneshot
${variables}
ExecStart=${systemdQuote(mt)} prs poll
StandardOutput=append:${log.replaceAll("%", "%%")}
StandardError=append:${log.replaceAll("%", "%%")}
`,
      [path.join(units, timer)]: `[Unit]
Description=Run mt prs poll every ${POLL_INTERVAL_MINUTES} minutes

[Timer]
OnCalendar=*:0/${POLL_INTERVAL_MINUTES}
Persistent=true

[Install]
WantedBy=timers.target
`
    },
    load: () => {
      runtime.exec("systemctl", ["--user", "daemon-reload"]);
      runtime.exec("systemctl", ["--user", "enable", "--now", timer]);
    },
    // Stopping the timer leaves a running poll to finish.
    unload: () => {
      runtime.exec("systemctl", ["--user", "disable", "--now", timer], { allowFailure: true });
      runtime.exec("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    }
  };
}

function pollLogPath(runtime: Runtime) {
  return path.join(getMonkeHome(runtime), "logs", "prs-poll.log");
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdQuote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}
