// Keeping it running: launchd on a Mac, systemd on Linux, Task Scheduler on Windows. All three start it at login.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const START = path.join(import.meta.dirname, "start.ts");
const WINDOWS = process.platform === "win32";
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type UnitOptions = {
  home: string;
  executable: string;
  program: string;
};

const systemdItem = (text: string, escapeDollar = false) => {
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error("systemd unit 的值不能包含控制字符");
  let escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (escapeDollar) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
};

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const searchPath = [path.dirname(process.execPath), ...systemPaths].join(":");
  const program = [process.execPath, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit(options: UnitOptions = { home: HOME, executable: process.execPath, program: PROGRAM }) {
  const environment = systemdItem(`AGENT_AUTOLOOP_HOME=${options.home}`);
  const command = [options.executable, "--disable-warning=ExperimentalWarning", options.program, "up"]
    .map((part) => systemdItem(part, true))
    .join(" ");
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=${environment}
ExecStart=${command}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const taskFile = () => path.join(HOME, "service.xml");
/** The task runs as whoever installed it, at logon, without asking for a password. */
const account = () => `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;

/**
 * A scheduled task that starts at logon and is asked again every minute: `IgnoreNew` makes the minute's ask a no-op
 * while the hub is up, and the one that starts it again when it isn't. `PT0S` removes the 72-hour limit a task has by
 * default, which would otherwise end the hub on the third day.
 */
export function taskXml(options: UnitOptions = { home: HOME, executable: process.execPath, program: PROGRAM }) {
  const arguments_ = ["--disable-warning=ExperimentalWarning", START, options.home, "up"]
    .map((part) => `"${part}"`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Agent 自动化中台</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(account())}</UserId></LogonTrigger><TimeTrigger><StartBoundary>2020-01-01T00:00:00</StartBoundary><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(account())}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>${xml(options.executable)}</Command>
    <Arguments>${xml(arguments_)}</Arguments>
    <WorkingDirectory>${xml(options.home)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (WINDOWS) {
    // schtasks reads the XML as UTF-16 with a byte order mark, and wants Windows line endings.
    writeFileSync(taskFile(), `\uFEFF${taskXml().replaceAll("\n", "\r\n")}`, "utf16le");
    execFileSync("schtasks", ["/Create", "/TN", label(), "/XML", taskFile(), "/F"], { stdio: "ignore" });
    execFileSync("schtasks", ["/Run", "/TN", label()], { stdio: "ignore" });
    return;
  }
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  if (WINDOWS) {
    // The task is asked for what it is, not for a file this program may have cleaned up already: a task that is left
    // behind with nothing pointing at it would never be found again.
    const asked = spawnSync("schtasks", ["/Query", "/TN", label(), "/XML"], { encoding: "utf8", windowsHide: true });
    if (asked.status !== 0) return;
    // Only the task this program wrote goes: the same name from another install, or from someone else, is left alone.
    if (!asked.stdout.includes(START) && !asked.stdout.includes(PROGRAM)) return;
    spawnSync("schtasks", ["/End", "/TN", label()], { stdio: "ignore" });
    // A task that is still running refuses to be deleted, and ending it is not instant: it is asked again until it stops.
    for (let tries = 0; tries < 40; tries++) {
      const answer = spawnSync("schtasks", ["/Delete", "/TN", label(), "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (answer.status === 0) {
        rmSync(taskFile(), { force: true });
        return;
      }
      // Gone already: someone else removed it between the two calls.
      if (spawnSync("schtasks", ["/Query", "/TN", label()], { stdio: "ignore" }).status !== 0) {
        rmSync(taskFile(), { force: true });
        return;
      }
      pause(250);
    }
    throw new Error(
      `任务计划里的服务删不掉：${spawnSync("schtasks", ["/Query", "/TN", label()], { encoding: "utf8" }).stdout}`,
    );
  }
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file)) return;
  const service = readFileSync(file, "utf8");
  const ownsService =
    process.platform === "darwin"
      ? service.includes(xml(PROGRAM))
      : service.includes(systemdItem(PROGRAM, true)) || service.includes(PROGRAM);
  if (!ownsService) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

/** The process that left its number in up.pid, if it still is that process: the number may be someone else's by now. */
export function runningUp() {
  const file = path.join(HOME, "up.pid");
  if (!existsSync(file)) return null;
  const pid = readFileSync(file, "utf8").trim();
  let command = "";
  try {
    command = WINDOWS
      ? (execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        ) ?? "")
      : execFileSync("ps", ["-p", pid, "-o", "command="], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
  } catch {}
  // On Windows the hub is started through host/start.ts, which sets the home and then becomes it.
  const ours = WINDOWS ? /(agent-autoloop(\.ts)?|start\.ts)[^"]*\bup\b/ : /agent-autoloop(\.ts)? up\b/;
  return ours.test(command) ? Number(pid) : null;
}

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  const pid = runningUp();
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
}

export function serviceRunning() {
  if (WINDOWS) {
    // schtasks prints its field names in the system language and its output is not UTF-8, so it is not read: the task's
    // state is asked for as an enum, whose name is the same on every Windows.
    const answer = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-ScheduledTask -TaskName '${label()}').State`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    return (answer.stdout ?? "").trim() === "Running";
  }
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}
