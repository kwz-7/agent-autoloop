// What this guards against: telling whether a turn's runner is still alive cost a `tasklist` call on Windows, which
// takes seconds once endpoint protection is watching, and it is asked at the start of every turn. Liveness must be a
// cheap check with the same answers: a live process is alive, a finished one is not, and the exit file settles it.
//
// Windows only: the other platforms answer with `ps`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

if (process.platform !== "win32") process.exit(0);

const { aliveWindows, beatFile } = await import("../worker/win.ts");

const directory = mkdtempSync(path.join(tmpdir(), "agent-autoloop-win-"));
const beat = beatFile(directory, 1);
const exit = path.join(directory, "exit-1");
let child: ReturnType<typeof spawn> | undefined;

function stopChild() {
  try {
    child?.kill();
  } catch {}
}

test.after(() => {
  stopChild();
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
});

test("一轮的进程还在的时候活着，退掉以后就不是了", async () => {
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid!;
  assert.equal(aliveWindows(pid, beat, exit), true, "还在跑的进程该算活着");

  stopChild();
  const gone = await until(() => aliveWindows(pid, beat, exit) === false);
  assert.equal(gone, true, "退掉的进程该算不在了");
});

test("退出文件在，就算进程号还能查到也不算活着", () => {
  const still = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    writeFileSync(exit, "0");
    assert.equal(aliveWindows(still.pid, beat, exit), false);
  } finally {
    still.kill();
    rmSync(exit, { force: true });
  }
});

test("心跳是新的，就不用去问系统这个进程号还在不在", () => {
  writeFileSync(beat, "");
  assert.equal(aliveWindows(999_999, beat, exit), true, "心跳新说明那一轮还在");
  rmSync(beat, { force: true });
});

test("没进程号就当它不在了", () => {
  assert.equal(aliveWindows(undefined, beat, exit), false);
});

async function until(condition: () => boolean, limit = 5000) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
