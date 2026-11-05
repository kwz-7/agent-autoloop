// Each test file runs in its own process with its own home and the fixture rules; modules are imported after this sets
// the environment they read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after } from "node:test";

export function setup(name: string, rules = "rules.fixture.json") {
  const directory = mkdtempSync(join(tmpdir(), `agent-autoloop-${name}-`));
  process.env.AGENT_AUTOLOOP_HOME = directory;
  // A rules path written out in full is used as it is: a leading slash only says that on POSIX, not a drive letter on Windows.
  process.env.AGENT_AUTOLOOP_RULES = isAbsolute(rules) ? rules : join(import.meta.dirname, rules);
  process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
  after(() => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
      // Windows refuses to remove a file another handle still has open; a temporary folder is not worth failing a test
      // that passed over, and the system cleans it up later.
      if (process.platform !== "win32") throw error;
    }
  });
  return directory;
}

/** A moment in a test's own time, minutes after a fixed start: 10:00 in Asia/Shanghai. */
export const at = (minutes: number) => Date.parse("2026-10-18T02:00:00.000Z") + minutes * 60_000;
