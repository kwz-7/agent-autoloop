// Failure modes: the worker cannot look a run up at all (the sandbox forbids it, or the program it asks is missing or not
// executable), and it reports a run that is still going as finished because the failed lookup was read as "the process is
// gone"; or, unable to look, it holds a stuck or stopped run forever because its timeout and its stop wait on a sighting
// that never comes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-look-"));
const home = join(scratch, "home");
const project = join(scratch, "project");
const bin = join(scratch, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.AGENT_AUTOLOOP_HOME = home;
if (!windows) process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

/** Put a ps in front of the real one that answers the question the way a gone process does. */
function psSaysGone() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

/**
 * Put a ps in front of the real one that fails the way one that cannot run does. A file without the execute bit would
 * not do: the lookup skips it and finds the real ps further along PATH, so outside a sandbox the test would check nothing.
 */
function psCannotRun() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 126\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

/** Where a run keeps the files this file looks at. */
function runFiles(run: number) {
  const dir = join(home, "worker", "runs", `${run}-1`);
  return { dir, entry: join(dir, "entry.json"), beat: join(dir, "beat-1"), exit: join(dir, "exit-1") };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windows asks the OS about a pid instead of starting ps. Every error but ESRCH and EPERM means the worker could not look;
 * this is the Windows stand-in for a ps that cannot run.
 */
const realKill = process.kill;
function noLookup() {
  process.kill = (() => {
    const error = new Error("lookup denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  }) as typeof process.kill;
}
function lookupBack() {
  process.kill = realKill;
}

/** Ticks until the run has a runner pid, so the test can take that runner away. */
async function launched(worker: { tick(): Promise<boolean> }, run: number) {
  const files = runFiles(run);
  for (let i = 0; i < 150; i++) {
    await worker.tick();
    if (existsSync(files.entry)) {
      const entry = JSON.parse(readFileSync(files.entry, "utf8"));
      if (entry.pid) return entry.pid as number;
    }
    await sleep(20);
  }
  assert.fail("the run never started");
}

/** Takes the runner and everything it started away: a run whose process is gone, with nothing left to say how it ended. */
async function takeRunAway(run: number) {
  const files = runFiles(run);
  const pid = JSON.parse(readFileSync(files.entry, "utf8")).pid as number;
  execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await gone(pid);
  // Killing the tree can let the runner publish an exit code just before it goes; this run is meant to have left none.
  rmSync(files.beat, { force: true });
  rmSync(files.exit, { force: true });
}

/** The OS lets go of a pid a moment after the kill: wait for that, so the lookup really says it is gone. */
async function gone(pid: number) {
  for (let i = 0; i < 100; i++) {
    try {
      realKill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await sleep(20);
  }
}

function workerThatReports(results: any[], job: any, now: () => number = Date.now) {
  let claimed = false;
  return createWorker({
    name: "test",
    wait: 0,
    now,
    hub: {
      work: async () => {
        const next = claimed ? null : job;
        claimed = true;
        return { job: next, cancel: [] };
      },
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

/** Each run gets its own number so one run's exit file is never read as another's. */
function jobFor(run: number, seconds: number, timeout?: number) {
  // Windows has no `sleep`, and its worker starts the command directly instead of through a shell.
  const command = windows
    ? [process.execPath, "-e", seconds === 0 ? "console.log('done')" : `setTimeout(() => {}, ${seconds * 1000})`]
    : ["/bin/sh", "-c", `sleep ${seconds}`];
  return {
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "lookup", cwd: project, prompt: "Read the input." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      timeout,
      command,
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

test("a run whose process is gone is reported as finished", async () => {
  if (windows) {
    // A long run taken away leaves no exit file: only the lookup says it is gone.
    const results: any[] = [];
    const worker = workerThatReports(results, jobFor(12, 30));
    await launched(worker, 12);
    await takeRunAway(12);
    for (let i = 0; i < 100 && !results.length; i++) {
      await worker.tick();
      await sleep(20);
    }
    assert.equal(results.length, 1, "the finished run was never reported");
    return;
  }
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(12, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});

test("a run that cannot be looked up is not reported as finished", async () => {
  if (windows) {
    const results: any[] = [];
    const worker = workerThatReports(results, jobFor(11, 30));
    await launched(worker, 11);
    await takeRunAway(11);
    noLookup();
    try {
      for (let i = 0; i < 60 && !results.length; i++) {
        await worker.tick();
        await sleep(20);
      }
      assert.equal(results.length, 0, "the run was reported before it finished");
    } finally {
      lookupBack();
      // This run is never reported in this test. Its record would be picked up by the next test's worker; on POSIX the fake
      // ps hides it there, but Windows would read it as a finished run and report it under the next run's results.
      rmSync(runFiles(11).dir, { recursive: true, force: true });
    }
    return;
  }
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(11, 30));
  for (let i = 0; i < 60 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 0, "the run was reported before it finished");
  process.kill(-JSON.parse(readFileSync(join(home, "worker", "runs", "11-1", "entry.json"), "utf8")).pid, "SIGKILL");
});

test("a stuck run that cannot be looked up still times out and is reported", async () => {
  if (windows) {
    const results: any[] = [];
    let moment = Date.now();
    const worker = workerThatReports(results, jobFor(15, 30, 1), () => moment);
    await launched(worker, 15);
    await takeRunAway(15);
    noLookup();
    try {
      await worker.tick();
      await worker.tick();
      assert.equal(results.length, 0, "the run was reported before its timeout");
      moment += 61_000;
      await worker.tick();
      moment += 11_000;
      for (let i = 0; i < 20 && !results.length; i++) {
        await worker.tick();
        await sleep(20);
      }
      assert.equal(results.length, 1, "the timed-out run was never reported");
    } finally {
      lookupBack();
    }
    return;
  }
  psCannotRun();
  const results: any[] = [];
  let moment = Date.now();
  const worker = workerThatReports(results, jobFor(15, 30, 1), () => moment);
  await worker.tick();
  await worker.tick();
  assert.equal(results.length, 0, "the run was reported before its timeout");
  moment += 61_000;
  await worker.tick();
  moment += 11_000;
  for (let i = 0; i < 20 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the timed-out run was never reported");
});

test("a run that cannot be looked up is reported once its exit file shows up", async () => {
  if (windows) {
    const results: any[] = [];
    noLookup();
    try {
      const worker = workerThatReports(results, jobFor(14, 0));
      for (let i = 0; i < 100 && !results.length; i++) {
        await worker.tick();
        await sleep(20);
      }
    } finally {
      lookupBack();
    }
    assert.equal(results.length, 1, "the finished run was never reported");
    return;
  }
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(14, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});
