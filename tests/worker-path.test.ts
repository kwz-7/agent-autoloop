// Failure modes: characters in the install path execute as shell source, command arguments are re-parsed,
// or the worker cannot recover the result from a directory containing quotes and command substitutions.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-path-"));
const home = join(scratch, "quote' $(touch path-injected)");
const project = join(scratch, "project");
mkdirSync(project);
process.env.AGENT_AUTOLOOP_HOME = home;
if (!windows) process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

// The POSIX worker quotes the command into a login shell's script. Windows has no shell wrapper: it writes the argv to a
// plan file and starts it directly, so the same characters have to survive JSON and argv instead.
const argument = "literal $(touch argv-injected)";
const command = windows
  ? [process.execPath, "-e", "console.log(process.argv[1]); console.error(process.env.AGENT_AUTOLOOP_HOME)", argument]
  : ["echo", argument];

test("install paths and command arguments stay literal through the worker wrapper", async () => {
  const results: any[] = [];
  let claimed = false;
  const job = {
    run: 1,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "literal", cwd: project, prompt: "Read the input." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      command,
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
  const worker = createWorker({
    name: "test",
    wait: 0,
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
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!existsSync(join(project, "path-injected")), "the install path executed a command");
  assert.ok(!existsSync(join(project, "argv-injected")), "an argument executed a command");
  assert.equal(results[0]?.summary, argument);
  assert.equal(results[0]?.outcome, "done");
  // The agent is also given AGENT_AUTOLOOP_HOME: the path with the quote and the command substitution in it has to reach it
  // as one argument, not as something evaluated on the way.
  if (windows) assert.equal(readFileSync(join(home, "worker", "runs", "1-1", "stderr-1.log"), "utf8").trim(), home);
});
