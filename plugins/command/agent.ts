// Anything with a print mode: its command line in rules.json, its last message on stdout. A script is an agent too, and
// a plain command needn't take the prompt at all: it finds what it needs through the environment (AGENT_AUTOLOOP_CONTEXT).
import { resolveProgram } from "../../host/programs.ts";
import { tail, type Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) => {
    const parts = (turn.command ?? []).map((part) =>
      part
        .replaceAll("{prompt}", turn.prompt)
        .replaceAll("{model}", turn.model ?? "")
        .replaceAll("{effort}", turn.effort ?? "")
        .replaceAll("{cwd}", turn.cwd)
        .replaceAll("{context}", turn.contextFile),
    );
    // A command named here is a name like any other: on Windows npm installs it as a `.cmd` shim or a `.js`, and
    // neither starts without what leads it.
    if (!parts.length) return parts;
    const [program, ...lead] = resolveProgram(parts[0]);
    return [program, ...lead, ...parts.slice(1)];
  },
  read(stdout, code, stderr) {
    if (code === null) return {};
    if (code !== 0) return { error: `退出码 ${code}：${tail(stderr || stdout) || "没留下原因"}` };
    return { text: stdout };
  },
} satisfies Adapter;
