// Started by the service. A scheduled task's action cannot carry environment variables, so the home travels as an
// argument and is set here, before the program reads it.
const home = process.argv[2];
if (home) process.env.AGENT_AUTOLOOP_HOME = home;
process.argv.splice(2, 1);
await import("../cli/main.ts");
