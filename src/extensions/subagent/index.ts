import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
import { buildSubagentPrompt } from "./context";
import { renderCall, renderResult } from "./render";
import { subagentSchema, type SubagentInput } from "./schema";
import {
  prewarmSubagentLoader,
  runSubagent,
  type SubagentDetails,
} from "./subagent";

// Deferred so the jiti compile pass runs after the session's initial paint
// and setup instead of competing with them for the event loop.
const PREWARM_DELAY_MS = 3_000;

// Inlined from pi-coding-agent's getAgentDir to avoid importing
// pi-coding-agent values at module load time.
function getAgentDir(): string {
  const envDir = process.env["PI_CODING_AGENT_DIR"];
  if (envDir) {
    return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
  }
  return join(homedir(), ".pi", "agent");
}

export default function (pi: ExtensionAPI): void {
  let prewarmTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelPrewarm = (): void => {
    if (prewarmTimer !== undefined) {
      clearTimeout(prewarmTimer);
      prewarmTimer = undefined;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    // Read cwd now, not in the timer: pi invalidates the ctx when the session
    // is replaced (/clear, resume, fork, /reload) or torn down, after which
    // every ctx getter throws — and a throw from a timer callback is an
    // uncaught exception that kills the process.
    const cwd = ctx.cwd;
    cancelPrewarm();
    prewarmTimer = setTimeout(() => {
      prewarmTimer = undefined;
      void prewarmSubagentLoader(cwd);
    }, PREWARM_DELAY_MS);
    prewarmTimer.unref?.();
  });

  pi.on("session_shutdown", cancelPrewarm);

  Tools.register<typeof subagentSchema, SubagentDetails>(pi, {
    name: "subagent",
    label: "subagent",
    description:
      "Run a task in an isolated subagent with a fresh context. " +
      "The subagent inherits the currently active tools, except subagent itself. " +
      "Multiple subagent calls in one turn run in parallel. " +
      "Subagent output returned to the main agent is capped at 32KB. " +
      "When using Oracle, the prompt must carry the full delegation context because parent history is not forwarded. Gather context first — directly or via Search subagents — then delegate. " +
      "Structure the brief as Objective, Scope/files, Known findings, Constraints, and Questions, and inline the actual evidence: quoted code excerpts cited as path:line, Search results, and relevant tool outputs. " +
      'Pass supporting source files via "context_paths" so their contents are inlined automatically; files the prompt cites as path:line are inlined too, so the subagent should be able to answer without re-reading the repo. ' +
      "Mark each finding VERIFIED or HYPOTHESIS, and keep already-proven fixes out of an Oracle brief. " +
      `Set "agent" to the name of a predefined agent from ${join(getAgentDir(), "agents")} ` +
      "(or the project's .pi/agents) to use its configured name, model, system prompt, and tools. " +
      'Use agent="Search" for broad code discovery. ' +
      'Use agent="Oracle" for code reviews, architecture feedback, difficult bugs across many files, planning complex implementations, deep technical reasoning, or an alternative perspective — but only after the user approves the consultation. ' +
      "Do NOT delegate to Oracle for file reads, simple searches, web browsing, or basic code changes — do those directly. " +
      "Omit agent only for a plain subagent that should inherit the current model.",
    parameters: subagentSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as SubagentInput;
      const prompt = await buildSubagentPrompt(
        input.prompt,
        input.context_paths,
        ctx.cwd
      );
      return runSubagent(
        prompt,
        ctx,
        signal,
        onUpdate,
        undefined,
        pi.getActiveTools(),
        input.agent
      );
    },
    renderCall,
    renderResult,
  });
}
