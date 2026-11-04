// What Windows has instead of a process group, `ps` and signals. Everything the worker needs to start a turn, tell
// whether it is still going, ask it to stop and take its whole tree down lives here.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WINDOWS = process.platform === "win32";

/** A heartbeat this old means the runner is gone; the agent it started may still be finishing. */
const BEAT_STALE = 10_000;

export const beatFile = (dir: string, turn: number) => path.join(dir, `beat-${turn}`);
export const stopFile = (dir: string, turn: number) => path.join(dir, `stop-${turn}`);
export const planFile = (dir: string, turn: number) => path.join(dir, `command-${turn}.json`);

export type Plan = { out: string; err: string; exit: string; beat: string; stop: string; cwd: string; argv: string[] };

/** Starts the runner detached: it outlives the worker, which is what makes a restart find a turn still going. */
export function spawnRunner(planPath: string, env: NodeJS.ProcessEnv): number | undefined {
  const runner = path.join(import.meta.dirname, "runner.ts");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", runner, planPath], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env,
  });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

/** Whether the turn's runner is still going: the heartbeat says so without spending a process on it. */
export function aliveWindows(pid: number | undefined, beat: string, exit: string): boolean | null {
  if (!pid) return false;
  if (existsSync(exit)) return false;
  try {
    if (existsSync(beat) && Date.now() - statSync(beat).mtimeMs < BEAT_STALE) return true;
  } catch {}
  return processExists(pid);
}

/** A process number alone is not enough; the worker only cares whether this one is still there. */
function processExists(pid: number): boolean | null {
  try {
    const printed = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return printed.includes(String(pid));
  } catch {
    return null;
  }
}

/**
 * Asked to stop, the runner reads this file and takes the tree down; `hard` does not wait for that. There is no
 * graceful stop to ask for: Windows ends a process, it cannot ask it to put its things away first.
 */
export function signalWindows(pid: number | undefined, stop: string, hard: boolean) {
  if (!pid) return;
  if (!hard) {
    try {
      writeFileSync(stop, String(Date.now()));
    } catch {}
    return;
  }
  killTree(pid);
}

export function killTree(pid: number) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {}
}

/** The process number in a file is only ours if it still runs the thing we started. */
export function runningCommand(pid: string): string {
  try {
    return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return "";
  }
}
