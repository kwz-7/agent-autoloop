// `agent-autoloop uninstall`, run from a copy of the program laid out as an install is, in a throwaway home with stand-ins for
// launchctl and systemctl (a Task Scheduler task of this install's own on Windows): nothing real can be reached. Failure
// cases: the service keeps running, or one started by hand does; a process that only has the old number is killed; a link or
// .cmd shim is left behind, in ~/.local/bin, elsewhere on PATH or among the Agents' Skills; someone's own file, folder or
// link of the same name is removed, or a link that leads somewhere else; the data is deleted by uninstall or --yes; with
// nobody at a terminal it hangs on the question; AGENT_AUTOLOOP_HOME naming the user's home, or a folder this program
// didn't make, gets it deleted.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const windows = process.platform === "win32";
const system32 = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "";
const powershellDir = windows ? join(system32, "WindowsPowerShell", "v1.0") : "";
const repo = join(import.meta.dirname, "..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-uninstall-")));
const children: ChildProcess[] = [];
const tasks: string[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  // A test that failed before uninstalling leaves its own task behind: take it away, but never the machine's real one.
  for (const name of tasks) {
    spawnSync("schtasks", ["/End", "/TN", name], { stdio: "ignore" });
    spawnSync("schtasks", ["/Delete", "/TN", name, "/F"], { stdio: "ignore" });
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    if (!windows) throw error;
  }
});

/** A port nothing is listening on: an install here may start a hub, and each one needs one of its own. */
const freePort = () =>
  Number(
    spawnSync(
      process.execPath,
      [
        "-e",
        `const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})`,
      ],
      { encoding: "utf8" },
    ).stdout.trim(),
  );

/** How Windows names a service for a home that isn't the default one, so another install can't collide with it. */
const taskName = (home: string) => `agent-autoloop-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
const queryTask = (name: string) =>
  spawnSync("schtasks", ["/Query", "/TN", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** A task Windows accepts, in the shape the product writes for the service it installs. */
function createTask(name: string, file: string, description: string, command: string, args: string, workdir: string) {
  const user = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const task = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(workdir)}</WorkingDirectory></Exec></Actions>
</Task>
`;
  writeFileSync(file, "\uFEFF" + task.replaceAll("\n", "\r\n"), "utf16le");
  const made = spawnSync("schtasks", ["/Create", "/TN", name, "/XML", file, "/F"], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  tasks.push(name);
}

let people = 0;
/** Somebody with an install in the usual place, things of their own around it, and links as the install script makes them. */
function install() {
  const person = join(dir, `person-${++people}`);
  const hub = join(person, ".agent-autoloop");
  const app = join(hub, "app");
  for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
    cpSync(join(repo, part), join(app, part), { recursive: true });
  }
  const standIns = join(person, "stand-ins");
  const called = join(person, "service-calls");
  mkdirSync(standIns, { recursive: true });
  if (!windows) {
    for (const name of ["launchctl", "systemctl"]) {
      writeFileSync(join(standIns, name), `#!/bin/sh\necho "${name} $*" >> "${called}"\nexit 1\n`);
      chmodSync(join(standIns, name), 0o755);
    }
  }
  const elsewhere = join(person, "elsewhere");
  const mine = join(person, "mine");
  const theirs = join(person, "theirs");
  const dangling = join(person, "dangling");
  const local = join(person, ".local", "bin");
  for (const place of [local, elsewhere, mine, theirs, dangling]) {
    mkdirSync(place, { recursive: true });
  }
  mkdirSync(join(person, ".claude"));
  mkdirSync(join(person, ".codex", "skills", "agent-autoloop"), { recursive: true });
  writeFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "their own");
  const program = join(app, "bin", "agent-autoloop.ts");
  const places = [local, elsewhere, mine, theirs, dangling];
  const path = windows ? [...places, system32, powershellDir] : [standIns, ...places, "/usr/bin", "/bin"];
  const base: NodeJS.ProcessEnv = windows
    ? {
        ...process.env,
        USERPROFILE: person,
        HOME: person,
        APPDATA: join(person, "AppData", "Roaming"),
        LOCALAPPDATA: join(person, "AppData", "Local"),
        TEMP: join(person, "Temp"),
        TMP: join(person, "Temp"),
        PATH: path.join(delimiter),
      }
    : { ...process.env, HOME: person, PATH: path.join(":") };
  for (const name of [
    "AGENT_AUTOLOOP_HOME",
    "AGENT_AUTOLOOP_RULES",
    "AGENT_AUTOLOOP_PUBLIC_URL",
    "AGENT_AUTOLOOP_COMMIT",
  ])
    delete base[name];
  for (const folder of ["AppData\\Roaming", "AppData\\Local", "Temp"]) {
    if (windows) mkdirSync(join(person, folder), { recursive: true });
  }
  // Windows takes the home from USERPROFILE, so this install is the usual place, which is what makes `init` link the Skill.
  // The machine may already run its own install's service under the name `agent-autoloop`, and a test must not touch that
  // one: uninstall is given the same folder spelled differently, so the service it looks for is this install's own.
  const remove = windows ? { ...base, USERPROFILE: person.toUpperCase(), AGENT_AUTOLOOP_HOME: hub } : base;
  const runAs =
    (env: NodeJS.ProcessEnv) =>
    (args: string[], over: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", program, ...args], {
        env: { ...env, ...over },
        encoding: "utf8",
        // `schtasks` and `taskkill` measure in seconds here (endpoint protection), and several run per uninstall.
        timeout: windows ? 120_000 : 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
  const setup = runAs(base);
  const run = runAs(remove);
  const port = windows ? freePort() : 3999;
  const set = setup(["init", "--no-service", "--command", "true", "--port", String(port)]);
  assert.equal(set.status, 0, set.stderr);
  if (windows) {
    const shim = (target: string) =>
      `@echo off\r\n"${process.execPath}" --disable-warning=ExperimentalWarning "${target}" %*\r\n`;
    writeFileSync(join(local, "agent-autoloop.cmd"), shim(program));
    writeFileSync(join(elsewhere, "agent-autoloop.cmd"), shim(program));
    writeFileSync(join(mine, "agent-autoloop.cmd"), "@echo off\r\necho mine\r\n");
    writeFileSync(join(theirs, "agent-autoloop.cmd"), shim(join(mine, "agent-autoloop.cmd")));
    writeFileSync(join(dangling, "agent-autoloop.cmd"), shim(join(person, "gone", "agent-autoloop.cmd")));
  } else {
    symlinkSync(program, join(local, "agent-autoloop"));
    symlinkSync(program, join(elsewhere, "agent-autoloop"));
    writeFileSync(join(mine, "agent-autoloop"), "#!/bin/sh\necho mine\n");
    symlinkSync(join(mine, "agent-autoloop"), join(theirs, "agent-autoloop"));
    symlinkSync(join(person, "gone"), join(dangling, "agent-autoloop"));
  }
  return { person, hub, app, env: base, remove, run, setup, called, local, elsewhere, mine, theirs, dangling, program };
}
type Install = ReturnType<typeof install>;
const skillLink = ({ person }: Install) => join(person, ".claude", "skills", "agent-autoloop");
const isThere = (file: string) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;
/** The command the installer puts on PATH: a link elsewhere, a .cmd on Windows. */
const command = (place: string) => join(place, windows ? "agent-autoloop.cmd" : "agent-autoloop");

function ownThingsAreThere(it: Install) {
  if (windows) {
    assert.equal(readFileSync(command(it.mine), "utf8"), "@echo off\r\necho mine\r\n");
    assert.ok(readFileSync(command(it.theirs), "utf8").includes(command(it.mine)));
    assert.ok(readFileSync(command(it.dangling), "utf8").includes(join(it.person, "gone")));
  } else {
    assert.equal(readFileSync(join(it.mine, "agent-autoloop"), "utf8"), "#!/bin/sh\necho mine\n");
    assert.equal(readlinkSync(join(it.theirs, "agent-autoloop")), join(it.mine, "agent-autoloop"));
    assert.equal(readlinkSync(join(it.dangling, "agent-autoloop")), join(it.person, "gone"));
  }
  assert.equal(readFileSync(join(it.person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "utf8"), "their own");
}

function linksAreGone(it: Install) {
  assert.ok(!isThere(command(it.local)), "no command left in ~/.local/bin");
  assert.ok(!isThere(command(it.elsewhere)), "or elsewhere on PATH");
  assert.ok(!isThere(skillLink(it)), "or among the Agents' Skills");
}

test("the install it makes is what it takes away: service stopped, links gone, all data always kept", () => {
  const it = install();
  assert.ok(lstatSync(skillLink(it)).isSymbolicLink(), "init linked the Skill");
  let done;
  if (windows) {
    // The service is a Task Scheduler task; uninstall ends it and deletes it, and takes the file it was made from.
    const name = taskName(it.hub);
    const installed = it.run(["service", "install"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(queryTask(name).status, 0, "the service is installed and running");
    done = it.run(["uninstall", "--yes"]);
    assert.equal(done.status, 0, done.stderr);
    assert.notEqual(queryTask(name).status, 0, "the service is gone");
    assert.ok(!existsSync(join(it.hub, "service.xml")), "and so is the task it was made from");
  } else {
    const service =
      process.platform === "darwin"
        ? join(it.person, "Library", "LaunchAgents", "agent-autoloop.plist")
        : join(it.person, ".config", "systemd", "user", "agent-autoloop.service");
    mkdirSync(join(service, ".."), { recursive: true });
    writeFileSync(service, `<string>${it.program}</string>`);

    done = it.run(["uninstall", "--yes"]);
    assert.equal(done.status, 0, done.stderr);
    const calls = readFileSync(it.called, "utf8");
    if (process.platform === "darwin")
      assert.match(calls, new RegExp(`launchctl bootout gui/${process.getuid!()}/agent-autoloop$`, "m"));
    else assert.match(calls, /^systemctl --user disable --now agent-autoloop$/m);
    assert.ok(!existsSync(service));
  }
  linksAreGone(it);
  ownThingsAreThere(it);
  assert.ok(existsSync(join(it.hub, "config.json")), "nobody was there to say yes, so the data stays");
  assert.match(done.stdout, /规则、密钥和记录还留在/);
  assert.ok(!existsSync(it.app), "the installed code is removed");
});

test("--yes skips confirmation and preserves all data", () => {
  const it = install();
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(existsSync(join(it.hub, "config.json")));
  assert.ok(!existsSync(it.app));
  linksAreGone(it);
  ownThingsAreThere(it);
  assert.ok(existsSync(it.person));
});

test("at a terminal only confirming removes the program, and every answer preserves data", () => {
  const answering = (it: Install, words: string) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const { uninstall } = await import(${JSON.stringify(pathToFileURL(join(it.app, "cli", "uninstall.ts")).href)});
         await uninstall(false, async () => ${JSON.stringify(words)});`,
      ],
      { env: it.remove, encoding: "utf8", timeout: windows ? 120_000 : 30_000 },
    );
  for (const [words, gone] of [
    ["", false],
    ["n", false],
    ["\n", false],
    ["y", true],
    ["Yes\n", true],
  ] as const) {
    const it = install();
    const done = answering(it, words);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(existsSync(it.hub), JSON.stringify(words));
    assert.equal(existsSync(it.app), !gone);
    if (gone) linksAreGone(it);
  }
});

test("a hub started by hand is stopped too; a process that only has the old number isn't", async () => {
  const it = install();
  const asIfUp = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "agent-autoloop", "up"], {
    stdio: "ignore",
  });
  children.push(asIfUp);
  writeFileSync(join(it.hub, "up.pid"), String(asIfUp.pid));
  const stopped = new Promise((resolve) => asIfUp.on("exit", resolve));
  assert.equal(it.run(["uninstall", "--yes"]).status, 0);
  await stopped;

  const other = install();
  // Only the pid in up.pid says this is a hub; its command line doesn't, so it isn't touched.
  const someoneElse = windows
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { stdio: "ignore" })
    : spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  children.push(someoneElse);
  writeFileSync(join(other.hub, "up.pid"), String(someoneElse.pid));
  assert.equal(other.run(["uninstall", "--yes"]).status, 0);
  assert.equal(someoneElse.exitCode, null);
  assert.equal(someoneElse.signalCode, null);
});

test("AGENT_AUTOLOOP_HOME can name anything: a folder this program didn't make, or the user's home, isn't deleted", () => {
  const it = install();
  const projects = join(it.person, "projects");
  mkdirSync(projects);
  writeFileSync(join(projects, "thesis.txt"), "years of work");
  const inFolder = it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: projects });
  assert.equal(inFolder.status, 0, inFolder.stderr);
  assert.equal(readFileSync(join(projects, "thesis.txt"), "utf8"), "years of work");
  assert.ok(existsSync(projects));

  writeFileSync(join(it.person, "config.json"), "{}");
  assert.equal(it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: it.person }).status, 0);
  assert.ok(existsSync(join(it.person, "config.json")));
  assert.ok(existsSync(join(it.hub, "config.json")));
});

test("with nothing installed it still finishes, and says so plainly", () => {
  const it = install();
  const nothing = it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: join(it.person, "never") });
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /卸载好了/);
});

test("without a terminal uninstall asks for --yes before removing anything", () => {
  const it = install();
  const done = it.run(["uninstall"]);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /--yes/);
  assert.ok(existsSync(it.app));
  assert.ok(isThere(command(it.local)));
});

test("an unrelated service with the same name is left running and untouched", () => {
  const it = install();
  let untouched;
  if (windows) {
    // Another program's task under this install's name, and the file it was made from.
    const name = taskName(it.hub);
    untouched = join(it.hub, "service.xml");
    createTask(name, untouched, "another program", join(system32, "cmd.exe"), "/c exit 0", it.person);
  } else {
    const service =
      process.platform === "darwin"
        ? join(it.person, "Library/LaunchAgents/agent-autoloop.plist")
        : join(it.person, ".config/systemd/user/agent-autoloop.service");
    mkdirSync(join(service, ".."), { recursive: true });
    writeFileSync(service, "another program");
    untouched = service;
  }
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  if (windows) {
    assert.equal(queryTask(taskName(it.hub)).status, 0, "another program's task stays where it is");
    const xml = spawnSync("schtasks", ["/Query", "/TN", taskName(it.hub), "/XML"], { encoding: "utf8" }).stdout;
    assert.match(xml, /another program/);
    assert.ok(!xml.includes(it.program), "and it still runs what it ran");
    assert.ok(readFileSync(untouched, "utf16le").includes("another program"), "and the file it was made from");
  } else {
    assert.equal(readFileSync(untouched, "utf8"), "another program");
  }
  assert.ok(!existsSync(it.called));
});
