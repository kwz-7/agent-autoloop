// A name on PATH is sometimes not a program: npm writes a .cmd, or a shell script, that runs the real one. This turns a
// name into something that can be started directly, which is what Windows needs and what the other platforms already get.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where a name on PATH is, as the program it actually runs. Windows only: elsewhere the name is startable as it is. */
export function findOnPath(name: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const printed = execFileSync("where.exe", [name], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // `where` also lists the extension-less shell script npm writes for Git Bash, which nothing here can start. The
    // first one PATH offers that can be started wins, the way it would anywhere else.
    const found = printed.trim().split(/\r?\n/).filter(Boolean);
    const program = found.find((file) => /\.(exe|cmd|bat)$/i.test(file));
    return program ? throughShim(program) : null;
  } catch {
    return null;
  }
}

/**
 * An npm shim is a .cmd that runs the program it installed, and only a shell can start one. Where the shim names that
 * program, start it instead: it is the same program without a command line in the middle to quote for.
 */
function throughShim(file: string): string {
  if (!/\.(cmd|bat)$/i.test(file)) return file;
  try {
    const named = readFileSync(file, "utf8").match(/"%dp0%\\([^"]+)"/);
    const real = named && path.join(path.dirname(file), named[1]);
    return real && existsSync(real) ? real : file;
  } catch {
    return file;
  }
}

/** A command line for a name on PATH: the program, and whatever has to lead it before its own arguments. */
export function resolveProgram(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const found = isPath(name) ? (existsSync(name) ? name : null) : (findOnPath(name) ?? fileOrNull(name));
  if (!found) return [name];
  if (/\.(cmd|bat)$/i.test(found)) return [process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", found];
  // A script npm installed is run by node, which is what the shim it came with would have done.
  if (/\.(c|m)?js$/i.test(found)) return [process.execPath, found];
  // A script that names node in its first line: Windows starts nothing on a shebang, node runs it instead.
  if (/^#!.*\bnode\b/.test(head(found))) return [process.execPath, found];
  return [found];
}

/** A name written as a path is a file to start, not something to look up. */
function isPath(name: string): boolean {
  return path.isAbsolute(name) || /[\\/]/.test(name);
}

function fileOrNull(name: string): string | null {
  return existsSync(name) ? name : null;
}

function head(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(0, 200);
  } catch {
    return "";
  }
}
