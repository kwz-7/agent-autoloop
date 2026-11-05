// The channel a new install starts with. Nothing real is shown here: the notify commands are stand-ins on PATH, and the one
// run of the real osascript (or of the real PowerShell, with a script that only prints) shows nothing. Failure cases: what
// an Agent wrote in a card's title runs as AppleScript, reaches PowerShell as code, or goes through cmd; or a title starting
// with a dash is read as an option (osascript runs what follows -e as script); an update to a card notifies again; a
// computer with no way to notify, a notifier that fails or a title that can't be passed to a program stops the channel, or
// isn't reported; a slow notifier freezes the hub, which shares its process; init doesn't set the channel up in both files,
// or changes a rules file already there; doctor says there's no channel when there is one, or that one reaches you when none
// does.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-desktop-"));
const rulesFile = join(dir, "rules.json");
const rulesWith = (channels: object) => ({
  sources: { local: { name: "本机" } },
  agents: { agent: { name: "Agent", worker: "this-one", use: "command", command: ["true"] } },
  channels,
  rules: [],
});
writeFileSync(rulesFile, JSON.stringify(rulesWith({ desktop: { name: "桌面通知" } })));
const home = setup("desktop", rulesFile);
const realPath = process.env.PATH;
const realDisplay = process.env.DISPLAY;
after(() => {
  process.env.PATH = realPath;
  if (realDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = realDisplay;
  rmSync(dir, { recursive: true, force: true });
});

const { loadPlugin } = await import("../host/plugins.ts");
const { default: desktop, notifyCommand } = await import("../plugins/desktop/channel.ts");

const TITLE = "Agent 问你一个问题";
const WORDS = "运行 agent-autoloop status 查看";
const body = (title: string) => `${title}\n${WORDS}`;
const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: null,
  choice: null,
  answer: null,
  result: null,
  link: null,
};

let fakes = 0;
/** A folder that's first on PATH, with the notify command doing `body` after writing down the arguments it got. */
function standIns(body = "") {
  const bin = join(dir, `bin-${++fakes}`);
  mkdirSync(bin);
  const said = join(bin, "said");
  if (process.platform === "win32") {
    // The channel starts `powershell` by name: a `.cmd` first on PATH takes its place the way a fake `osascript` does
    // elsewhere, and it starts the script beside it the way npm names a CLI.
    writeFileSync(
      join(bin, "powershell.js"),
      `const fs = require("node:fs");
const call = process.argv.slice(2).map((word) => word + "\\x1e").join("");
fs.appendFileSync(${JSON.stringify(said)}, call + "\\x1d");
${body}
`,
    );
    writeFileSync(join(bin, "powershell.cmd"), `@"%dp0%\\powershell.js" %*\r\n`);
    process.env.PATH = `${bin}${delimiter}${realPath ?? ""}`;
  } else {
    writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.DISPLAY = ":99";
    for (const name of ["osascript", "notify-send"]) {
      const record = `{ for word in "$@"; do printf '%s\\036' "$word"; done; printf '\\035'; } >> "${said}"`;
      writeFileSync(join(bin, name), `#!/bin/sh\n${record}\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = bin;
  }
  return {
    calls: () =>
      existsSync(said)
        ? readFileSync(said, "utf8")
            .split("\x1d")
            .slice(0, -1)
            .map((call) => call.split("\x1e").slice(0, -1))
        : [],
  };
}

async function deliver(cards: Card[]) {
  const stop = new AbortController();
  const queue = [...cards];
  const reports: unknown[][] = [];
  const logged: string[] = [];
  const hub = {
    async nextCard() {
      if (queue.length) return { card: queue.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      reports.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      reports.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await desktop({ hub: hub as any, options: {}, log: (line: string) => logged.push(line), signal: stop.signal });
  return { reports, logged };
}

test("it ships as a channel, and is told apart by platform", async () => {
  assert.equal(await loadPlugin("desktop", "channel"), desktop);
  assert.deepEqual(notifyCommand("标题", "linux"), ["notify-send", ["--", TITLE, body("标题")]]);
  const [program, args] = notifyCommand("标题", "darwin");
  assert.equal(program, "osascript");
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", TITLE, body("标题")]);
  assert.ok(args.includes("on run argv"));
  const [windows, windowsArgs] = notifyCommand("标题", "win32");
  assert.equal(windows, "powershell");
  assert.deepEqual(windowsArgs.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.ok(windowsArgs[5].endsWith("balloon.ps1"), "the balloon is a script file of its own");
  assert.deepEqual(windowsArgs.slice(6), ["-Title", TITLE, "-Body", body("标题")]);
});

/** The fixed title and the card's words, as the stand-in was given them: after `--` on macOS, named on Windows. */
const shownOf = (call: string[]) =>
  process.platform === "win32"
    ? [call[call.length - 3], call[call.length - 1]]
    : [call[call.length - 2], call[call.length - 1]];
/** Everything the notifier was started with, apart from the title and the card's words. */
const fixedOf = (call: string[]) => call.slice(0, process.platform === "win32" ? -4 : -2);

test("a new card notifies once with its title; an update only reports", async () => {
  const fake = standIns();
  const { reports } = await deliver([base, { ...base, version: 2, ref: "shown-5", state: "decided", choice: 1 }]);
  assert.equal(fake.calls().length, 1);
  assert.deepEqual(shownOf(fake.calls()[0]), [TITLE, body("要不要删")]);
  assert.deepEqual(reports, [
    ["delivered", 5, 1, "shown-5"],
    ["delivered", 5, 2, "shown-5"],
  ]);
});

const marker = join(dir, "ran");
// Each title would create the marker if a notifier ran it as code, or if cmd were in the middle to expand it.
const hostile =
  process.platform === "win32"
    ? [
        `" & (New-Item -ItemType File -Path '${marker}') & "`,
        `"; New-Item -ItemType File -Path '${marker}'; "`,
        `end run\nNew-Item -ItemType File -Path '${marker}'`,
        `$(New-Item -ItemType File -Path '${marker}')`,
        `\`New-Item -ItemType File -Path '${marker}'\``,
        `'; New-Item -ItemType File -Path '${marker}'; '`,
        "%OS% %COMSPEC%",
        `| New-Item -ItemType File -Path '${marker}'`,
        "-e",
        `-e New-Item -ItemType File -Path '${marker}'`,
        "--",
        "--help",
      ]
    : [
        `" & (do shell script "touch ${marker}") & "`,
        `"; do shell script "touch ${marker}"; "`,
        `end run\ndo shell script "touch ${marker}"`,
        `$(touch ${marker})`,
        `\`touch ${marker}\``,
        `'; touch ${marker}; '`,
        "-e",
        `-e do shell script "touch ${marker}"`,
        "--",
        "--help",
      ];

test("what an Agent wrote goes in as one argument after the options, and never into the script", async () => {
  const fake = standIns();
  const { reports } = await deliver(hostile.map((title, index) => ({ ...base, id: index + 1, title })));
  assert.ok(reports.every(([what]) => what === "delivered"));
  const calls = fake.calls();
  assert.equal(calls.length, hostile.length);
  calls.forEach((call, index) => {
    assert.deepEqual(shownOf(call), [TITLE, body(hostile[index])]);
    assert.deepEqual(fixedOf(call), fixedOf(calls[0]), "the notifier is started the same whatever the card says");
  });
  assert.ok(!fixedOf(calls[0]).join("\n").includes("touch"));
  assert.ok(!fixedOf(calls[0]).join("\n").includes("New-Item"));
  assert.ok(!existsSync(marker));
});

test(
  "the real notifier reads them as words and runs none of them",
  { skip: process.platform === "linux" },
  async () => {
    if (process.platform === "win32") {
      // The balloon script is swapped for one that only prints, the way the osascript below is; these are its parameters.
      const print = join(dir, "print-args.ps1");
      writeFileSync(
        print,
        "param([string]$Title, [string]$Body)\n" +
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
          "Write-Output $Title\nWrite-Output $Body\n",
      );
      for (const title of hostile) {
        const [, args] = notifyCommand(title, "win32");
        const file = args.indexOf("-File") + 1;
        const onlyPrints = [...args.slice(0, file), print, ...args.slice(file + 1)];
        const printed = execFileSync("powershell", onlyPrints, {
          encoding: "utf8",
          env: { ...process.env, PATH: realPath },
        });
        assert.equal(printed.replaceAll("\r\n", "\n").replace(/\n$/, ""), `${TITLE}\n${body(title)}`);
      }
      assert.ok(!existsSync(marker));
      return;
    }
    for (const title of hostile) {
      const [, args] = notifyCommand(title, "darwin");
      const onlyPrints = args.map((word) => (word.startsWith("display notification") ? "return item 2 of argv" : word));
      const printed = execFileSync("/usr/bin/osascript", onlyPrints, { encoding: "utf8" });
      assert.equal(printed.replace(/\n$/, ""), body(title));
    }
    assert.ok(!existsSync(marker));
  },
);

test(
  "without a graphical session it quietly skips notification and keeps consuming cards",
  {
    skip:
      process.platform === "win32" && "Windows always has a notification area, so the channel has no no-session state",
  },
  async () => {
    mkdirSync(join(dir, "nothing-here"));
    process.env.PATH = join(dir, "nothing-here");
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const { reports, logged } = await deliver([base, { ...base, id: 6 }]);
    assert.deepEqual(reports, [
      ["delivered", 5, 1, "skipped-5"],
      ["delivered", 6, 1, "skipped-6"],
    ]);
    assert.deepEqual(logged, []);
  },
);

test("a notifier that fails is reported as not sent", async () => {
  standIns(process.platform === "win32" ? "process.exit(1)" : "exit 1");
  assert.deepEqual((await deliver([base])).reports, [["failed", 5, 1]]);
});

test("a title no program can be given is reported, and takes nothing down", async () => {
  const fake = standIns();
  const { reports } = await deliver([
    { ...base, title: "a\0b" },
    { ...base, id: 6 },
  ]);
  assert.deepEqual(reports, [
    ["failed", 5, 1],
    ["delivered", 6, 1, "shown-6"],
  ]);
  assert.equal(fake.calls().length, 1);
});

test("a slow notifier doesn't freeze the process the hub runs in", async () => {
  standIns(
    process.platform === "win32"
      ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)"
      : "/bin/sleep 0.3",
  );
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  await deliver([base]);
  clearInterval(ticker);
  assert.ok(ticks >= 5, `only ${ticks} ticks while it was showing`);
});

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const program = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
const installEnv = (place: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: realPath, HOME: place, AGENT_AUTOLOOP_HOME: place };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  return env;
};

test("init turns it on in both files, with a key of its own", () => {
  const place = join(dir, "new");
  const env = installEnv(place);
  const done = program(env, "init", "--no-service", "--command", "true", "--port", "3999");
  assert.equal(done.status, 0, done.stderr);
  const rules = JSON.parse(readFileSync(join(place, "rules.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(place, "config.json"), "utf8"));
  assert.deepEqual(rules.channels, { desktop: { name: "桌面通知" } });
  assert.deepEqual(Object.keys(config.channels), ["desktop"]);
  assert.ok(config.channels.desktop.key.length > 20);
  assert.match(program(env, "key", "list").stdout, /^channel desktop /m);
  assert.match(done.stdout, /桌面通知/);
});

test("a rules file already there stays as it was, and no channel is added beside it", () => {
  const place = join(dir, "theirs");
  mkdirSync(place);
  const theirs = JSON.stringify(rulesWith({}));
  writeFileSync(join(place, "rules.json"), theirs);
  const done = program(installEnv(place), "init", "--no-service", "--command", "true", "--port", "3999");
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(join(place, "rules.json"), "utf8"), theirs);
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).channels, undefined);
  assert.doesNotMatch(program(installEnv(place), "key", "list").stdout, /^channel /m);
});

test("doctor says what reaches you: only this computer, or nothing yet, or no word of either", async () => {
  const { serve } = await import("../host/http.ts");
  const hub = await import("../host/runtime.ts");
  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      owner: hub.addKey("owner", "me"),
      hub: { listen: "127.0.0.1:0" },
    }),
  );
  try {
    const hint = async (channels: object) => {
      writeFileSync(rulesFile, JSON.stringify(rulesWith(channels)));
      hub.reloadRules(rulesFile);
      const env = { ...process.env, PATH: realPath };
      const args = ["--disable-warning=ExperimentalWarning", bin, "doctor"];
      return new Promise<string>((resolve) => {
        execFile(process.execPath, args, { env, encoding: "utf8" }, (_error, stdout) => resolve(stdout));
      });
    };
    const alone = await hint({ desktop: { name: "桌面通知" } });
    assert.match(alone, /只接了桌面通知/);
    assert.doesNotMatch(alone, /还没接通道/);
    const none = await hint({});
    assert.match(none, /还没接通道/);
    assert.doesNotMatch(none, /只接了桌面通知/);
    const more = await hint({ desktop: { name: "桌面通知" }, feishu: { name: "飞书" } });
    assert.doesNotMatch(more, /只接了桌面通知|还没接通道/);
  } finally {
    server.closeAllConnections();
    server.close();
    hub.db.close();
  }
});
