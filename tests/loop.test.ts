// The whole loop, with nothing faked but the agent: a real `agent-autoloop up` in its own process, from `init` on, through the
// protocol as everything else speaks it. An event comes in; the agent runs and asks; the owner answers from the command line;
// the agent goes on and finishes. Failure cases: init leaves something out; `up` doesn't start, or starts twice; the run isn't
// started in its folder; the question doesn't reach the owner; `status` doesn't show what to do about it; the answer doesn't
// wake the thread; the result isn't recorded; `try` hangs for an answer when nobody's at a terminal, as when an Agent runs it;
// the user's Agents aren't told how to set it up, or something of the user's own is overwritten doing so, or a test install does it;
// the question doesn't show on the desktop, shows again once answered, or a test run puts up a real notification.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const windows = process.platform === "win32";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-loop-"));
const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
// `init` turns on the desktop channel: these stand in for the commands that would really show something. On Windows the
// notifier is PowerShell, and a `.cmd` first on PATH takes its place the way a fake `osascript` does elsewhere.
const notifiers = join(home, "notifiers");
const notified = join(home, "notified.txt");
const notifications = () => (existsSync(notified) ? readFileSync(notified, "utf8").trim().split("\n") : []);
mkdirSync(notifiers);
if (windows) {
  writeFileSync(join(notifiers, "powershell.cmd"), `@echo off\r\n@"%dp0%\\powershell.js" %*\r\n`);
  // Whatever is shown is the last argument: a balloon's body carries the card's title and the line under it.
  writeFileSync(
    join(notifiers, "powershell.js"),
    `require("node:fs").appendFileSync(${JSON.stringify(notified)}, process.argv.slice(2).at(-1) + "\\n");\n`,
  );
} else {
  writeFileSync(join(notifiers, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const name of ["osascript", "notify-send"]) {
    const recordTitle = `while [ "$1" != "--" ]; do shift; done\nprintf '%s\\n' "$3" >> "${notified}"\n`;
    writeFileSync(join(notifiers, name), `#!/bin/sh\n${recordTitle}`, { mode: 0o755 });
  }
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_AUTOLOOP_HOME: home,
  PATH: `${notifiers}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
  ...(windows ? {} : { DISPLAY: ":99" }),
};
delete env.AGENT_AUTOLOOP_RULES;
delete env.AGENT_AUTOLOOP_PUBLIC_URL;
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const fence = "```";
// Asks on its first go; with an answer in the context file, finishes. Asked to, it only says something. A `.js` file with a
// shebang: POSIX starts it from that line, Windows through node, which is what `host/programs.ts` turns a `.js` into.
const script = join(home, "agent.js");
const agentBody = `const fs = require("node:fs");
const context = fs.readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8");
const block = (payload) => "\\n\\n" + ${JSON.stringify(fence)} + "agent-autoloop\\n" + JSON.stringify(payload) + "\\n" + ${JSON.stringify(fence)};
if (context.includes("card.answered")) {
  console.log("你选了绿色，做完了");
} else if (context.includes("hello.notice")) {
  console.log("说了一声" + block({ notice: [{ title: "留意一下", text: "磁盘快满了", key: "disk" }] }));
} else {
  fs.writeFileSync(${JSON.stringify(join(home, "where.txt"))}, process.cwd() + "\\n");
  console.log("问了一个问题" + block({ ask: [{ title: "试跑：选一个颜色", text: "选哪个都行", options: ["蓝色", "绿色"], recommend: 1, key: "color" }] }));
}
`;
writeFileSync(script, `#!${process.execPath}\n${agentBody}`, { mode: 0o755 });

let up: ReturnType<typeof spawn> | undefined;
after(async () => {
  if (up && up.exitCode === null && up.signalCode === null) {
    up.kill("SIGTERM");
    await new Promise((resolve) => up!.once("exit", resolve));
  }
  rmSync(home, { recursive: true, force: true });
});

test("one machine, one command: an event, a question, an answer, the work done", async () => {
  const port = await freePort();
  const done = cli("init", "--no-service", "--command", script, "--port", String(port));
  assert.equal(done.status, 0, done.stderr);
  if (windows) {
    const acl = spawnSync("icacls", [join(home, "config.json")], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(acl, /Everyone|BUILTIN\\\\Users|Authenticated Users/, "its keys are private");
  } else {
    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600, "its keys are private");
  }
  assert.equal(cli("init", "--no-service").status, 1, "a second init doesn't overwrite the first");
  assert.equal(cli("check").status, 0);
  // Point the starter rule at something this test owns.
  const rules = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  mkdirSync(join(home, "work"));
  rules.rules[0].cwd = join(home, "work");
  rules.rules[0].when.types = ["hello.*", "try.*"];
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));

  up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], { env, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  // `cli` holds up this process, so a connection kept open can time out at the hub unnoticed, and the next request on it
  // is reset. Each request gets its own.
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { headers: { connection: "close", ...headers } });
  for (let i = 0; i < 100; i++) {
    if (
      await get("/healthz").then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await (await get("/healthz")).json()).ok, true);
  const second = cli("up");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /已经在跑了/);

  const emitted = cli("emit", "hello.world", "--subject", "x-1", "--summary", "你好");
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.match(emitted.stdout, /交给了：试一下/);

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const state = async () => (await get("/v1/state", { authorization: `Bearer ${config.owner}` })).json();
  const until = async (done: (s: any) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const now = await state();
      if (done(now)) return now;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`timed out: ${JSON.stringify((await state()).runs)}`);
  };
  const asking = await until((s) => s.cards.length === 1);
  const card = asking.cards[0];
  assert.equal(card.title, "试跑：选一个颜色");
  assert.ok(readFileSync(join(home, "where.txt"), "utf8").includes("work"));
  const waiting = cli("status");
  assert.match(waiting.stdout, /等你 1/);
  assert.match(waiting.stdout, new RegExp(`#${card.id} 试跑：选一个颜色`));
  assert.match(waiting.stdout, /2\. 绿色（推荐）/);
  assert.match(waiting.stdout, new RegExp(`agent-autoloop answer ${card.id} `));

  // The notifier runs on its own, and a card answered before it gets there isn't shown at all.
  await until(() => notifications().length === 2);
  assert.equal(cli("answer", String(card.id), "7").status, 1, "there's no seventh option");
  const answered = cli("answer", String(card.id), "2");
  assert.equal(answered.status, 0, answered.stderr);
  const finished = await until((s) =>
    s.runs.some((r: any) => r.summary === "你选了绿色，做完了" && r.state === "done"),
  );
  assert.equal(finished.cards.length, 0);
  assert.equal(finished.recentCards[0].state, "done");
  assert.equal(finished.recentCards[0].result, "你选了绿色，做完了");
  assert.equal(finished.recentCards[0].by, "本人");
  assert.deepEqual(
    notifications(),
    ["试跑：选一个颜色", "运行 agent-autoloop status 查看"],
    "once, and not for the answer",
  );
  assert.match(cli("answer", String(card.id), "1").stdout, /已经/);

  const status = cli("status");
  assert.match(status.stdout, /在跑 0 · 排队 0 · 今天做完 2 · 等你 0/);
  assert.match(status.stdout, /你选了绿色，做完了/);
  const told = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "tell", "note-1"], {
    env,
    encoding: "utf8",
    input: "告诉你一声\n",
  });
  assert.match(told.stdout, /说了/);
  assert.match(cli("status").stdout, /告诉你一声/);
  cli("emit", "hello.notice");
  const noticed = await until((s) => s.cards.some((c: any) => c.kind === "notice"));
  const notice = noticed.cards.find((c: any) => c.kind === "notice");
  assert.match(cli("status").stdout, new RegExp(`处理完了：agent-autoloop answer ${notice.id}`));
  assert.match(cli("answer", String(notice.id)).stdout, /结案了/);

  // Nobody at a terminal, as when an Agent is installing it: `try` says what's being asked and how to answer, and doesn't wait.
  const tried = cli("try");
  assert.equal(tried.status, 0, tried.stderr);
  assert.match(tried.stdout, /试跑：选一个颜色/);
  const id = /agent-autoloop answer (\d+) /.exec(tried.stdout)![1];
  const resolved = cli("resolve", id, "不试了");
  assert.match(resolved.stdout, /结案了/);
  assert.equal((await state()).recentCards.find((c: any) => c.id === Number(id)).result, "不试了");
  assert.equal(cli("resolve", id).status, 1, "a result has to be written");
  assert.equal((await get("/")).status, 404);
});

test("the user's Agents are shown how to set it up, when this is the install in its usual place, and nothing of theirs is touched", () => {
  const person = mkdtempSync(join(tmpdir(), "agent-autoloop-person-"));
  mkdirSync(join(person, ".claude"));
  mkdirSync(join(person, ".codex", "skills", "agent-autoloop"), { recursive: true });
  writeFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "their own");
  // Windows takes the home directory from USERPROFILE; the other platforms from HOME.
  const usual: NodeJS.ProcessEnv = { ...env, HOME: person, USERPROFILE: person };
  delete usual.AGENT_AUTOLOOP_HOME;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", bin, "init", "--no-service", "--command", "true"],
    { env: usual, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(done.status, 0, done.stderr);
  assert.equal(
    realpathSync(join(person, ".claude", "skills", "agent-autoloop")),
    realpathSync(join(import.meta.dirname, "..", "skills", "agent-autoloop")),
  );
  // A link is a symlink where the platform has them and a junction on Windows, where it does not.
  if (!windows) assert.ok(lstatSync(join(person, ".claude", "skills", "agent-autoloop")).isSymbolicLink());
  assert.equal(readFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "utf8"), "their own");
  assert.ok(existsSync(join(person, ".agent-autoloop", "config.json")));
  rmSync(person, { recursive: true, force: true });
  assert.ok(!existsSync(join(home, ".claude")), "an install somewhere else leaves the user's Agents alone");
});
