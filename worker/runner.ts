// Windows has no /bin/sh to hang output redirection and an exit code off, so this program does that job for one turn: it
// spawns the agent directly, keeps a heartbeat while it runs, and leaves the same files the POSIX wrapper does. The
// worker starts it detached, so it keeps running after the worker stops, exactly like the wrapper it replaces.
//   node runner.ts <plan.json>
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

type Plan = { out: string; err: string; exit: string; beat: string; stop: string; cwd: string; argv: string[] };

/** How often the heartbeat is touched, and the stop file looked at. */
const TICK = 250;

const plan: Plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const beat = () => writeFileSync(plan.beat, String(Date.now()));

/** The exit code is published the way the shell writes it: a complete file appears, or none does. */
function end(code: number) {
  const file = `${plan.exit}.tmp`;
  writeFileSync(file, String(code));
  renameSync(file, plan.exit);
}

beat();
const out = openSync(plan.out, "w");
const err = openSync(plan.err, "w");
const child = spawn(plan.argv[0], plan.argv.slice(1), {
  cwd: plan.cwd,
  windowsHide: true,
  stdio: ["ignore", out, err],
});
closeSync(out); // the child holds its own copy
closeSync(err);

let killed = false;
/** The agent may start children of its own, so the whole tree goes, not just the process we spawned. */
function killTree() {
  if (killed || !child.pid) return;
  killed = true;
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } catch {}
}

const timer = setInterval(() => {
  beat();
  // The worker asks for a stop by leaving this file: Windows has no signal to send, and nothing to catch it with.
  if (!killed && existsSync(plan.stop)) killTree();
}, TICK);

child.on("error", (error) => {
  clearInterval(timer);
  writeFileSync(plan.err, `在 ${plan.cwd} 启动不了：${error}\n`, { flag: "a" });
  end(127);
  process.exit(0);
});

child.on("exit", (code) => {
  clearInterval(timer);
  end(code ?? 1);
  process.exit(0);
});
