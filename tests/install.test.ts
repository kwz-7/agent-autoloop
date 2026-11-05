// install.sh (install.ps1 on Windows), in a throwaway home with a PATH made of nothing but temporary folders. The program it
// sets up is a copy of this one and `git` is a stand-in that makes that copy, so nothing needs committing and no real folder
// can be written to. On Windows the command is a `.cmd` on PATH and the service a Task Scheduler task of the install's own,
// and the older shell is the Windows PowerShell 5.1 that comes with Windows. Failure cases: the command goes somewhere that
// isn't on PATH, so `agent-autoloop` isn't found right after installing; someone's own agent-autoloop is overwritten; with
// nowhere to put it, or someone else's coming first, the next step printed doesn't work; the next step says `try` when
// nothing has been started; it asks for sudo (or, on Windows, to be run as administrator); the Node advice can't be followed
// as written; running it again redoes the setup, or installs a service after --no-service. A normal umask or a pre-existing
// directory must not expose the database, event text or worker output to other users (on Windows: the root's ACL).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

const windows = process.platform === "win32";
const system32 = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "";
const powershell5 = windows ? join(system32, "WindowsPowerShell", "v1.0", "powershell.exe") : "";
const repo = join(import.meta.dirname, "..");
const script = join(repo, windows ? "install.ps1" : "install.sh");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-install-")));
const copy = join(dir, "the-program");
for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
  cpSync(join(repo, part), join(copy, part), { recursive: true });
}
// The shell the script itself is run with: PowerShell 7 if it's there, otherwise the Windows PowerShell 5.1 every Windows has.
const pwsh = windows
  ? (spawnSync("where.exe", ["pwsh"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean)[0] ?? powershell5)
  : "/bin/sh";
const locked: string[] = [];
const tasks: string[] = [];
/** A service's name for a home that isn't the default one, which is how a test's own service avoids the machine's. */
const taskName = (home: string) => `agent-autoloop-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
const queryTask = (name: string) =>
  spawnSync("schtasks", ["/Query", "/TN", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const stopTask = (name: string) => {
  spawnSync("schtasks", ["/End", "/TN", name], { stdio: "ignore" });
  spawnSync("schtasks", ["/Delete", "/TN", name, "/F"], { stdio: "ignore" });
};
after(() => {
  for (const name of tasks) stopTask(name);
  for (const folder of locked) {
    if (windows) spawnSync("icacls", [folder, "/remove:d", process.env.USERNAME ?? ""], { stdio: "ignore" });
    else chmodSync(folder, 0o755);
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (!windows) throw error;
  }
});

/** A port nothing is listening on: a service started here has a hub of its own on one. */
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

const system = (name: string) => ["/bin", "/usr/bin"].map((place) => join(place, name)).find(existsSync)!;
const executable = (file: string, body: string) => {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

let people = 0;
/** Somebody's computer: a home, and a folder of the commands the script needs that it can't write to. */
function computer({ node = "real" }: { node?: "real" | "old" | "none" } = {}) {
  const person = join(dir, `person-${++people}`);
  const tools = join(person, "tools");
  mkdirSync(tools, { recursive: true });
  const called = join(person, "called");
  if (windows) {
    // The commands the script itself runs are copied in here, so every folder on PATH belongs to this test.
    for (const name of ["icacls.exe", "where.exe"]) copyFileSync(join(system32, name), join(tools, name));
    const git = join(tools, "git.js");
    writeFileSync(
      git,
      `
const { appendFileSync, cpSync, mkdirSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(called)}, "git " + args.join(" ") + "\\n");
if (args[0] === "clone") {
  const target = args.at(-1);
  cpSync(${JSON.stringify(copy)}, target, { recursive: true });
  mkdirSync(target + "\\\\.git");
}
`,
    );
    writeFileSync(join(tools, "git.cmd"), `@echo off\r\n"${process.execPath}" "${git}" %*\r\n`);
    // `node` is a stand-in too: the real one on PATH would be a folder this test must not write the command into.
    if (node === "real") writeFileSync(join(tools, "node.cmd"), `@echo off\r\n"${process.execPath}" %*\r\n`);
    if (node === "old")
      writeFileSync(join(tools, "node.cmd"), `@echo off\r\nif "%~1"=="-v" (echo v22.1.0) else (exit /b 1)\r\n`);
    // Nothing in this folder may be written to: that's how "there is nowhere to put it" is said on Windows.
    const denied = spawnSync("icacls", [tools, "/deny", `${process.env.USERNAME}:(WD)`], { encoding: "utf8" });
    assert.equal(denied.status, 0, denied.stderr);
    locked.push(tools);
  } else {
    for (const name of ["mkdir", "ln", "cat", "cp", "chmod"]) symlinkSync(system(name), join(tools, name));
    executable(
      join(tools, "git"),
      `echo "git $*" >> "${called}"
if [ "$1" = clone ]; then for target; do :; done; cp -R "${copy}" "$target"; mkdir "$target/.git"; fi`,
    );
    // `launchctl print` failing says nothing's loaded, which is what lets a first load go ahead at once.
    executable(join(tools, "launchctl"), `echo "launchctl $*" >> "${called}"\n[ "$1" != print ]`);
    executable(join(tools, "systemctl"), `echo "systemctl $*" >> "${called}"`);
    if (node === "real") symlinkSync(process.execPath, join(tools, "node"));
    if (node === "old") executable(join(tools, "node"), `[ "$1" = -v ] && echo v22.1.0 || exit 1`);
    chmodSync(tools, 0o555);
    locked.push(tools);
  }
  const hub = join(person, ".agent-autoloop");
  const program = join(hub, "app", "bin", "agent-autoloop.ts");
  const local = join(person, ".local", "bin");
  const run = (
    path: string[],
    args = ["--no-service", "--command", "true", "--port", "3999"],
    shell = pwsh,
    extra = {},
  ) => {
    const env: NodeJS.ProcessEnv = windows
      ? {
          ...process.env,
          USERPROFILE: person,
          HOME: person,
          APPDATA: join(person, "AppData", "Roaming"),
          LOCALAPPDATA: join(person, "AppData", "Local"),
          TEMP: join(person, "Temp"),
          TMP: join(person, "Temp"),
          PATH: [...path, tools].join(delimiter),
          ...extra,
        }
      : { HOME: person, PATH: [...path, tools].join(":") };
    for (const name of ["AGENT_AUTOLOOP_HOME", "AGENT_AUTOLOOP_RULES", "AGENT_AUTOLOOP_PUBLIC_URL"]) delete env[name];
    for (const name of Object.keys(extra)) env[name] = (extra as NodeJS.ProcessEnv)[name];
    const command = windows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]
      : [script, ...args];
    return spawnSync(shell, command, {
      env,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: windows ? person : undefined,
    });
  };
  return { person, tools, hub, program, local, called, run, folder: (name: string) => join(person, name) };
}
const made = (place: string) => {
  mkdirSync(place, { recursive: true });
  return place;
};
/** The command the installer puts on PATH: a link on POSIX, a `.cmd` on Windows. */
const commandFile = (place: string) => join(place, windows ? "agent-autoloop.cmd" : "agent-autoloop");
const shim = (program: string) =>
  `@echo off\r\n"${process.execPath}" --disable-warning=ExperimentalWarning "${program}" %*\r\n`;
/** Whether what the installer left on PATH runs this program. */
const pointsTo = (place: string, program: string) =>
  windows ? readFileSync(commandFile(place), "utf8").includes(program) : readlinkSync(commandFile(place)) === program;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("installation keeps data private even when its root already exists and others could use it", () => {
  const it = computer();
  if (windows) {
    // The folder is there before the install, with the permissions it inherits from everywhere else.
    mkdirSync(it.hub, { recursive: true });
    const done = it.run([it.local]);
    assert.equal(done.status, 0, done.stderr + done.stdout);
    const acl = spawnSync("icacls", [it.hub], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(acl, /\(I\)/, "nothing is inherited from the folder above");
    assert.match(acl, /\(OI\)\(CI\)\(F\)/, "and it carries into what is created below");
    assert.ok(acl.includes(process.env.USERNAME!), "only this account");
    assert.doesNotMatch(acl, /BUILTIN\\|NT AUTHORITY\\/, "not to other users or to SYSTEM");
  } else {
    mkdirSync(it.hub, { mode: 0o755 });
    chmodSync(it.hub, 0o755);
    const done = it.run([it.local]);
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.equal(statSync(it.hub).mode & 0o777, 0o700);
  }
});

test("the command goes in ~/.local/bin when that's on PATH, even behind another place it could go", () => {
  const it = computer();
  const other = made(it.folder("other"));
  const done = it.run([other, it.local]);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(pointsTo(it.local, it.program));
  assert.ok(!existsSync(commandFile(other)));
  assert.match(done.stdout, /先运行 agent-autoloop up 启动中台，再开一个终端运行 agent-autoloop try/);
  assert.doesNotMatch(done.stdout, /alias/);
});

test(
  `the same goes for ${
    windows ? "Windows PowerShell 5.1, which every Windows already has" : "dash, which is what sh is on Ubuntu"
  }`,
  { skip: windows ? !existsSync(powershell5) : !existsSync("/bin/dash") },
  () => {
    const it = computer();
    const done = it.run([it.local], undefined, windows ? powershell5 : "/bin/dash");
    assert.equal(done.status, 0, done.stderr);
    assert.ok(pointsTo(it.local, it.program));
    assert.doesNotMatch(done.stdout, /alias/);
  },
);

test("with ~/.local/bin not on PATH it goes in the first place that is, and leaves ~/.local/bin alone", () => {
  const it = computer();
  const first = made(it.folder("first"));
  const second = made(it.folder("second"));
  const done = it.run(["relative/bin", ".", it.folder("not-there"), first, second]);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(pointsTo(first, it.program));
  assert.ok(!existsSync(it.local));
  assert.ok(!existsSync(commandFile(second)));
  assert.match(done.stdout, /agent-autoloop try/);
  assert.doesNotMatch(done.stdout, /alias/);
});

test("someone's own agent-autoloop stays as it was, and the next step doesn't send them to it", () => {
  const it = computer();
  const theirs = made(it.local);
  if (windows) writeFileSync(join(theirs, "agent-autoloop.cmd"), "@echo off\r\necho their own\r\n");
  else executable(join(theirs, "agent-autoloop"), "echo their own");
  const after = made(it.folder("after"));
  const done = it.run([theirs, after]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(readFileSync(commandFile(theirs), "utf8"), /echo their own/);
  assert.ok(pointsTo(after, it.program));
  assert.match(done.stdout, new RegExp(`先运行 ${escape(it.program)} up`));
  if (windows)
    assert.match(done.stdout, new RegExp(`function agent-autoloop \\{ & "[^"]*" "${escape(it.program)}" @args \\}`));
  else assert.match(done.stdout, new RegExp(`alias agent-autoloop='${it.program}'`));

  // A command of their own that points somewhere else is someone else's too, so it's left as it is.
  const linked = computer();
  const place = made(linked.local);
  if (windows) writeFileSync(join(place, "agent-autoloop.cmd"), shim(join(place, "somewhere-else")));
  else symlinkSync(join(place, "somewhere-else"), join(place, "agent-autoloop"));
  assert.equal(linked.run([place]).status, 0);
  if (windows) assert.match(readFileSync(commandFile(place), "utf8"), /somewhere-else/);
  else assert.equal(readlinkSync(join(place, "agent-autoloop")), join(place, "somewhere-else"));
});

test(
  "with nowhere on PATH to put it, the next step gives the full path and no command is left anywhere",
  { skip: process.getuid?.() === 0 },
  () => {
    const it = computer();
    const done = it.run([]);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(!existsSync(it.local));
    assert.ok(done.stdout.includes(`先运行 ${it.program} up 启动中台，再开一个终端运行 ${it.program} try`));
    if (windows)
      assert.match(done.stdout, new RegExp(`function agent-autoloop \\{ & "[^"]*" "${escape(it.program)}" @args \\}`));
    else assert.match(done.stdout, new RegExp(`alias agent-autoloop='${it.program}'`));
    // Nothing in it asks for more rights than it needs.
    assert.doesNotMatch(readFileSync(script, "utf8"), windows ? /sudo|Verb RunAs/i : /sudo/);
  },
);

test("the next step is try alone when a service has been started", () => {
  const it = computer();
  if (windows) {
    // The service is a Task Scheduler task, and this install may not take over the machine's own one: the home is given to
    // the script spelled differently, which is a service name of this install's own.
    const home = it.hub.toUpperCase();
    mkdirSync(it.local, { recursive: true });
    // The program is told about itself under the spelling it was run with, so that's what a command naming it has to say.
    writeFileSync(join(it.local, "agent-autoloop.cmd"), shim(join(home, "app", "bin", "agent-autoloop.ts")));
    tasks.push(taskName(home));
    const done = it.run([system32, it.local], ["--command", "true", "--port", String(freePort())], undefined, {
      AGENT_AUTOLOOP_HOME: home,
    });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /运行 agent-autoloop try 跑一遍完整流程/);
    assert.doesNotMatch(done.stdout, /agent-autoloop up/);
    assert.equal(queryTask(taskName(home)).status, 0, "the service is installed");
    stopTask(taskName(home));
  } else {
    const done = it.run([it.local], ["--command", "true", "--port", "3999"]);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /运行 agent-autoloop try 跑一遍完整流程/);
    assert.doesNotMatch(done.stdout, /agent-autoloop up/);
  }
});

for (const [node, words] of [
  ["old", /需要 Node\.js 24 或更新，现在是 v22\.1\.0/],
  ["none", /需要 Node\.js 24 或更新，这台电脑上没找到/],
] as const) {
  test(`with Node ${node === "old" ? "too old" : "missing"} it says what to run, and those lines work as written`, () => {
    const it = computer({ node });
    const done = it.run([]);
    assert.equal(done.status, 1);
    assert.match(done.stdout, words);
    if (windows) {
      assert.match(done.stdout, /^ +winget install OpenJS\.NodeJS\.LTS$/m);
      assert.match(done.stdout, /^ +winget install Schniz\.fnm$/m);
      assert.match(done.stdout, /^ +fnm install 24 ; fnm default 24$/m);
      assert.doesNotMatch(done.stdout, /brew|nvm|sudo/);
    } else {
      assert.match(done.stdout, /^ +brew install node@24$/m);
      assert.match(done.stdout, /^ +nvm install 24$/m);
    }
    assert.ok(!existsSync(it.hub), "nothing is set up");
    if (windows) {
      // Every line the message prints, run as it's printed, with package managers that only take the arguments they should.
      const shell = made(it.folder("shell"));
      const log = join(shell, "installed");
      const fake = (name: string, accepted: string[][]) => {
        const file = join(shell, `${name}.js`);
        writeFileSync(
          file,
          `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + args.join(" ") + "\\n");
const accepted = ${JSON.stringify(accepted)};
process.exit(accepted.some((expected) => expected.join("\\u0000") === args.join("\\u0000")) ? 0 : 1);
`,
        );
        writeFileSync(join(shell, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`);
      };
      fake("winget", [
        ["install", "OpenJS.NodeJS.LTS"],
        ["install", "Schniz.fnm"],
      ]);
      fake("fnm", [
        ["install", "24"],
        ["default", "24"],
      ]);
      const lines = done.stdout
        .split(/\r?\n/)
        .filter((printed) => /^ {2}\S/.test(printed) && !/^\s*#/.test(printed))
        .map((printed) => printed.trim());
      assert.equal(lines.length, 3);
      for (const line of lines) {
        const pasted = spawnSync(pwsh, ["-NoProfile", "-Command", line], {
          env: { ...process.env, USERPROFILE: shell, HOME: shell, PATH: shell },
          encoding: "utf8",
          cwd: shell,
        });
        assert.equal(pasted.status, 0, `${line}: ${pasted.stderr}`);
      }
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
        "winget install OpenJS.NodeJS.LTS",
        "winget install Schniz.fnm",
        "fnm install 24",
        "fnm default 24",
      ]);
    } else {
      // The line about PATH, as it's printed, run where `brew --prefix` answers as Homebrew does.
      const shell = made(it.folder("shell"));
      executable(join(shell, "brew"), `[ "$*" = "--prefix node@24" ] && echo /homebrew/opt/node@24`);
      const line = done.stdout.split("\n").find((printed) => printed.includes("brew --prefix"))!;
      const pasted = spawnSync("/bin/sh", ["-c", line.trim()], {
        env: { HOME: shell, PATH: shell },
        encoding: "utf8",
      });
      assert.equal(pasted.status, 0, pasted.stderr);
      assert.equal(readFileSync(join(shell, ".zshrc"), "utf8"), 'export PATH="/homebrew/opt/node@24/bin:$PATH"\n');
    }
  });
}

test("running it again updates and doesn't set anything up over what's there", () => {
  const it = computer();
  assert.equal(it.run([it.local]).status, 0);
  writeFileSync(join(it.hub, "rules.json"), "my rules");
  const config = readFileSync(join(it.hub, "config.json"), "utf8");
  rmSync(it.called);
  const kept = it.run([it.local]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /更新好了/);
  assert.equal(readFileSync(join(it.hub, "rules.json"), "utf8"), "my rules");
  assert.equal(readFileSync(join(it.hub, "config.json"), "utf8"), config);
  assert.ok(pointsTo(it.local, it.program));
  assert.deepEqual(readFileSync(it.called, "utf8").trim().split("\n"), [
    `git -C ${join(it.hub, "app")} pull --ff-only --quiet`,
  ]);

  rmSync(it.called);
  if (windows) {
    // Without --no-service an update restarts the service; spelled differently, it's this install's own task.
    const home = it.hub.toUpperCase();
    tasks.push(taskName(home));
    assert.equal(
      it.run([system32, it.local], ["--command", "true", "--port", String(freePort())], undefined, {
        AGENT_AUTOLOOP_HOME: home,
      }).status,
      0,
    );
    const pulled = readFileSync(it.called, "utf8").trim();
    assert.match(pulled, /^git -C .*[\\/]app pull --ff-only --quiet$/m);
    assert.ok(pulled.toLowerCase().includes(join(it.hub, "app").toLowerCase()));
    assert.equal(queryTask(taskName(home)).status, 0, "without --no-service an update restarts the service");
    const xml = spawnSync("schtasks", ["/Query", "/TN", taskName(home), "/XML"], { encoding: "utf8" }).stdout;
    assert.ok(
      xml.toLowerCase().includes(join(it.hub, "app", "host", "start.ts").toLowerCase()),
      "and the task runs this install",
    );
    stopTask(taskName(home));
  } else {
    assert.equal(it.run([it.local], []).status, 0);
    const service = process.platform === "darwin" ? /^launchctl bootstrap /m : /^systemctl --user enable --now /m;
    assert.match(readFileSync(it.called, "utf8"), service, "without --no-service an update restarts the service");
  }
});
