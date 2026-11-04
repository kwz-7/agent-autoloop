// Every test but the simulation, on any platform: a shell cannot be trusted to expand a glob or to leave one file out.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts") && name !== "simulation.test.ts")
  .map((name) => `tests/${name}`);
const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...files], {
  stdio: "inherit",
});
process.exit(run.status ?? 1);
