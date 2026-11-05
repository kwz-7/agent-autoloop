// Started by the service. A scheduled task's action cannot carry environment variables, so the home travels as an
// argument and is set here, before the program reads it. And a task has no console to print to: what the hub and the
// worker say goes to a file instead, which is where it would have gone under launchd or systemd.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const given = process.argv[2];
if (given) {
  process.env.AGENT_AUTOLOOP_HOME = given;
  process.argv.splice(2, 1);
}
const home = process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop");

// Started by the service, not by hand: the home came as an argument. A task has a console nobody can see, so what would
// have been printed there is written down instead.
if (given) {
  const logs = path.join(home, "logs");
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "up.log");
  const toFile = (chunk: string | Uint8Array) => {
    appendFileSync(file, chunk);
    return true;
  };
  process.stdout.write = toFile as typeof process.stdout.write;
  process.stderr.write = toFile as typeof process.stderr.write;
}

await import("../cli/main.ts");
