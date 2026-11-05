# Installs Agent 自动化中台 on Windows: a clone in %USERPROFILE%\.agent-autoloop\app, with nothing to build and nothing
# else to install. The counterpart of install.sh, and it does the same three things: clone, make the command reachable,
# and hand over to `init`.
$ErrorActionPreference = "Stop"

$Repo = if ($env:AGENT_AUTOLOOP_REPO) { $env:AGENT_AUTOLOOP_REPO } else { "https://github.com/kwz-7/agent-autoloop.git" }
# The Windows version is what this script came from, so that is what it installs: the branch is cloned, not main.
$Branch = if ($env:AGENT_AUTOLOOP_BRANCH) { $env:AGENT_AUTOLOOP_BRANCH } else { "windows-native" }
$Root = if ($env:AGENT_AUTOLOOP_HOME) { $env:AGENT_AUTOLOOP_HOME } else { Join-Path $HOME ".agent-autoloop" }
$App = Join-Path $Root "app"
$Program = Join-Path $App "bin\agent-autoloop.ts"

function Need-Node([string]$why) {
  Write-Host $why
  Write-Host @'
装 Node.js 24 或更新：
  winget install OpenJS.NodeJS.LTS
  # 或用 fnm：
  winget install Schniz.fnm
  fnm install 24 ; fnm default 24
装好后再运行一遍这个安装命令。
'@
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "需要 git。"; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Need-Node "需要 Node.js 24 或更新，这台电脑上没找到。" }
$major = [int](((node -v) -replace '^v', '') -split '\.')[0]
if ($major -lt 24) { Need-Node "需要 Node.js 24 或更新，现在是 $(node -v)。" }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
# 0700 on Windows is an ACL: only this account, nothing inherited, and carried into what gets created below.
& icacls $Root /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

if (Test-Path (Join-Path $App ".git")) {
  & git -C $App pull --ff-only --quiet
} else {
  & git clone --quiet --depth 1 --branch $Branch -- $Repo $App
}

# 临时 HOME（测试、CI）只装这一份，不动这台电脑的 PATH：命令给人用的是默认安装的事。
# Only a folder that's on PATH makes `agent-autoloop` work, and an agent-autoloop that isn't this one is someone else's.
$nodePath = (Get-Command node).Source
$shim = "@echo off`r`n`"$nodePath`" --disable-warning=ExperimentalWarning `"$Program`" %*`r`n"
$local = Join-Path $HOME ".local\bin"
$onPath = @($env:PATH -split ';' | Where-Object { $_ })
$places = @($local) + $onPath
if (-not $env:AGENT_AUTOLOOP_HOME) {
  foreach ($place in $places) {
    # A folder the shell won't look in is no place for the command; a relative one would mean wherever someone happens to be.
    if (-not [System.IO.Path]::IsPathRooted($place)) { continue }
    if ($onPath -notcontains $place) { continue }
    if (-not (Test-Path $place -PathType Container)) {
      if ($place -ne $local) { continue }
      New-Item -ItemType Directory -Force -Path $place | Out-Null
    }
    $file = Join-Path $place "agent-autoloop.cmd"
    if (Test-Path $file) {
      if (-not (Select-String -Path $file -SimpleMatch $Program -Quiet)) { continue }
      Set-Content -Path $file -Value $shim -Encoding ascii
      break
    }
    try {
      Set-Content -Path $file -Value $shim -Encoding ascii -ErrorAction Stop
      break
    } catch { continue }
  }
}

if (Test-Path (Join-Path $Root "config.json")) {
  Write-Host "更新好了。"
  if ($args -notcontains "--no-service") { & node $Program service install }
} else {
  & node "--disable-warning=ExperimentalWarning" $Program init @args
}

$onPath = Get-Command agent-autoloop -ErrorAction SilentlyContinue
# The name works only when what a shell would run is this program: an earlier agent-autoloop of someone else's comes first.
$ours = $false
if ($onPath) {
  try { $ours = [bool](Select-String -Path $onPath.Source -SimpleMatch $Program -Quiet) } catch { $ours = $false }
}
if ($env:AGENT_AUTOLOOP_HOME) {
  # 临时 HOME 不往 PATH 里放东西，也就没有要提醒的。
} elseif (-not $ours) {
  Write-Host ""
  Write-Host "直接打 agent-autoloop 运行不了这个程序：PATH 上没有能放它的目录，或者排在前面的是另一个同名程序。"
  Write-Host "要写完整路径 $Program，或者把这一行加进 PowerShell 的 $PROFILE："
  Write-Host "  function agent-autoloop { & `"$nodePath`" `"$Program`" @args }"
}
