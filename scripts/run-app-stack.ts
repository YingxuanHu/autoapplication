import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type Mode = "dev" | "start";

type ParsedArgs = {
  mode: Mode;
  withDaemon: boolean;
};

type DaemonLock = {
  pid: number;
  startedAt: string;
  argv: string[];
};

type RunningDaemonLock = {
  pid: number;
  startedAt: string | null;
  argv: string[];
};

const DAEMON_RESTART_BASE_DELAY_MS = 2_000;
const DAEMON_RESTART_MAX_DELAY_MS = 30_000;
const DAEMON_STABLE_WINDOW_MS = 2 * 60 * 1000;

function parseArgs(rawArgs: string[]): ParsedArgs {
  let mode: Mode = "dev";
  let withDaemon = process.env.DISABLE_INGEST_DAEMON !== "1";

  for (const rawArg of rawArgs) {
    const arg = rawArg.replace(/^--/, "");
    if (arg === "no-daemon") {
      withDaemon = false;
      continue;
    }

    if (arg === "daemon") {
      withDaemon = true;
      continue;
    }

    const [key, value] = arg.split("=");
    if (key === "mode" && (value === "dev" || value === "start")) {
      mode = value;
    }
  }

  return {
    mode,
    withDaemon,
  };
}

function startNext(mode: Mode) {
  const args =
    mode === "dev"
      ? [
          "--max-old-space-size=2048",
          "./node_modules/next/dist/bin/next",
          "dev",
          "--webpack",
        ]
      : ["./node_modules/next/dist/bin/next", "start"];

  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
}

function startDaemon() {
  const daemonArgs = [
    "-r",
    "dotenv/config",
    "scripts/ingest-daemon.ts",
    "--force",
  ];

  const intervalMinutes = process.env.INGEST_DAEMON_INTERVAL_MINUTES?.trim();
  if (intervalMinutes) {
    daemonArgs.splice(3, 0, `--interval=${intervalMinutes}`);
  }

  return spawn("./node_modules/.bin/tsx", daemonArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
}

const DAEMON_LOCK_PATH = path.join(
  process.cwd(),
  ".runtime",
  "ingest-daemon.lock.json"
);

async function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getRunningDaemonLock() {
  try {
    const raw = await readFile(DAEMON_LOCK_PATH, "utf8");
    const lock = JSON.parse(raw) as Partial<DaemonLock>;
    if (typeof lock.pid !== "number") {
      return null;
    }

    if (!(await processExists(lock.pid))) {
      return null;
    }

    return {
      pid: lock.pid,
      startedAt: typeof lock.startedAt === "string" ? lock.startedAt : null,
      argv: Array.isArray(lock.argv) ? lock.argv.filter((value): value is string => typeof value === "string") : [],
    };
  } catch {
    return null;
  }
}

function getDesiredDaemonIntervalMinutes() {
  const intervalMinutes = process.env.INGEST_DAEMON_INTERVAL_MINUTES?.trim();
  if (!intervalMinutes) {
    return 10;
  }

  const parsed = Number.parseInt(intervalMinutes, 10);
  return Number.isFinite(parsed) ? parsed : 10;
}

function getDaemonIntervalMinutes(argv: string[]) {
  const explicitArg = argv.find((arg) => arg.startsWith("--interval="));
  if (!explicitArg) {
    return 10;
  }

  const parsed = Number.parseInt(explicitArg.slice("--interval=".length), 10);
  return Number.isFinite(parsed) ? parsed : 10;
}

async function replaceExistingDaemon(existingDaemon: RunningDaemonLock) {
  try {
    process.kill(existingDaemon.pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!(await processExists(existingDaemon.pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try {
    process.kill(existingDaemon.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function killChildTree(child: ChildProcess, signal: NodeJS.Signals | number) {
  if (!child.pid) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall back to direct child signal below
    }
  }

  try {
    child.kill(signal);
  } catch {
    // child already gone
  }
}

async function main() {
  const { mode, withDaemon } = parseArgs(process.argv.slice(2));
  const children = new Set<ChildProcess>();
  let shuttingDown = false;
  let forceShutdown = false;
  let forcedShutdownTimer: NodeJS.Timeout | null = null;
  let daemonRestartTimer: NodeJS.Timeout | null = null;
  let daemonRestartAttempts = 0;
  let daemonStartedAt = 0;
  let resolveWhenDone: (() => void) | null = null;

  const waitForChildrenToExit = new Promise<void>((resolve) => {
    resolveWhenDone = resolve;
  });

  const maybeResolveWhenDone = () => {
    if (children.size === 0 && !daemonRestartTimer) {
      resolveWhenDone?.();
    }
  };

  const clearDaemonRestartTimer = () => {
    if (!daemonRestartTimer) return;
    clearTimeout(daemonRestartTimer);
    daemonRestartTimer = null;
  };

  const web = startNext(mode);
  children.add(web);

  let daemon: ChildProcess | null = null;
  const spawnManagedDaemon = () => {
    const nextDaemon = startDaemon();
    daemonStartedAt = Date.now();
    daemon = nextDaemon;
    children.add(nextDaemon);
    registerExit("daemon", nextDaemon);
    return nextDaemon;
  };
  if (withDaemon) {
    const existingDaemon = await getRunningDaemonLock();
    if (existingDaemon) {
      if (mode === "dev") {
        console.log(
          `[stack] Replacing existing ingest daemon pid ${existingDaemon.pid} in dev mode`
        );
        await replaceExistingDaemon(existingDaemon);
        daemon = spawnManagedDaemon();
      } else {
      const desiredIntervalMinutes = getDesiredDaemonIntervalMinutes();
      const existingIntervalMinutes = getDaemonIntervalMinutes(existingDaemon.argv);

      if (existingIntervalMinutes !== desiredIntervalMinutes) {
        console.log(
          `[stack] Replacing existing ingest daemon pid ${existingDaemon.pid} (${existingIntervalMinutes}min) with ${desiredIntervalMinutes}min config`
        );
        await replaceExistingDaemon(existingDaemon);
        daemon = spawnManagedDaemon();
      } else {
        const existingArgs =
          existingDaemon.argv.length > 0 ? ` (${existingDaemon.argv.join(" ")})` : "";
        console.log(
          `[stack] Reusing existing ingest daemon pid ${existingDaemon.pid}${existingArgs}`
        );
      }
      }
    } else {
      daemon = spawnManagedDaemon();
    }
  }

  console.log(
    `[stack] Started ${mode === "dev" ? "Next dev" : "Next start"}${withDaemon ? " + ingest daemon" : ""}`
  );

  const shutdown = (signal: NodeJS.Signals) => {
    if (forceShutdown) return;

    if (shuttingDown) {
      forceShutdown = true;
      if (forcedShutdownTimer) {
        clearTimeout(forcedShutdownTimer);
        forcedShutdownTimer = null;
      }
      clearDaemonRestartTimer();
      console.log(`\n[stack] Force shutdown (${signal})...`);
      for (const child of children) {
        killChildTree(child, "SIGKILL");
      }
      process.exit(130);
    }

    shuttingDown = true;
    clearDaemonRestartTimer();
    console.log(`\n[stack] Shutting down (${signal})...`);

    for (const child of children) {
      killChildTree(child, signal);
    }

    forcedShutdownTimer = setTimeout(() => {
      if (children.size === 0 || forceShutdown) return;
      forceShutdown = true;
      console.log("\n[stack] Graceful shutdown timed out. Killing remaining processes.");
      for (const child of children) {
        killChildTree(child, "SIGKILL");
      }
    }, 8000);
    forcedShutdownTimer.unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  function registerExit(name: string, child: ChildProcess) {
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (name === "daemon" && daemon === child) {
        daemon = null;
      }

      if (children.size === 0 && forcedShutdownTimer) {
        clearTimeout(forcedShutdownTimer);
        forcedShutdownTimer = null;
      }

      if (name === "web" && !shuttingDown) {
        shuttingDown = true;
        for (const sibling of children) {
          killChildTree(sibling, "SIGTERM");
        }
      }

      if (name === "daemon" && withDaemon && !shuttingDown) {
        const runtimeMs = daemonStartedAt > 0 ? Date.now() - daemonStartedAt : 0;
        if (runtimeMs >= DAEMON_STABLE_WINDOW_MS) {
          daemonRestartAttempts = 0;
        } else {
          daemonRestartAttempts += 1;
        }

        const restartDelayMs = Math.min(
          DAEMON_RESTART_MAX_DELAY_MS,
          DAEMON_RESTART_BASE_DELAY_MS *
            2 ** Math.max(0, daemonRestartAttempts - 1)
        );

        console.log(
          `[stack] daemon exited${signal ? ` via ${signal}` : ` with code ${code ?? 0}`}; restarting in ${(restartDelayMs / 1000).toFixed(0)}s`
        );

        clearDaemonRestartTimer();
        daemonRestartTimer = setTimeout(() => {
          daemonRestartTimer = null;
          if (shuttingDown || !withDaemon) {
            maybeResolveWhenDone();
            return;
          }

          console.log("[stack] restarting ingest daemon");
          spawnManagedDaemon();
        }, restartDelayMs);
        daemonRestartTimer.unref?.();
        return;
      }

      if (signal) {
        console.log(`[stack] ${name} exited via ${signal}`);
        process.exitCode = process.exitCode ?? 0;
        maybeResolveWhenDone();
        return;
      }

      console.log(`[stack] ${name} exited with code ${code ?? 0}`);
      process.exitCode = process.exitCode ?? code ?? 0;
      maybeResolveWhenDone();
    });
  }

  registerExit("web", web);
  maybeResolveWhenDone();
  await waitForChildrenToExit;
}

main().catch((error) => {
  console.error("[stack] Failed to start app stack:", error);
  process.exitCode = 1;
});
