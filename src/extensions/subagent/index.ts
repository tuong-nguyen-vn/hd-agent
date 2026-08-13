import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
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
  pi.on("session_start", (_event, ctx) => {
    const timer = setTimeout(() => {
      void prewarmSubagentLoader(ctx.cwd);
    }, PREWARM_DELAY_MS);
    timer.unref?.();
  });

  Tools.register<typeof subagentSchema, SubagentDetails>(pi, {
    name: "subagent",
    label: "subagent",
    description:
      "Run a task in an isolated subagent with a fresh context. " +
      "The subagent inherits the currently active tools, except subagent itself. " +
      "Multiple subagent calls in one turn run in parallel. " +
      "Subagent output returned to the main agent is capped at 32KB. " +
      "When using Oracle, the prompt must carry the delegation context because unrelated parent history is not forwarded. Include: objective, scope/files, known findings with evidence, constraints, and specific questions or decisions. " +
      `Set "agent" to the name of a predefined agent from ${join(getAgentDir(), "agents")} ` +
      "(or the project's .pi/agents) to use its configured name, model, system prompt, and tools. " +
      'Use agent="Search" for broad code discovery. ' +
      'Use agent="Oracle" for code reviews, architecture feedback, difficult bugs across many files, planning complex implementations, deep technical reasoning, or an alternative perspective. ' +
      "Use a compact structure such as Objective, Scope/files, Known findings, Constraints, and Questions; include short excerpts or tool results only when they materially support the task. " +
      "Do NOT delegate to Oracle for file reads, simple searches, web browsing, or basic code changes — do those directly. " +
      "Omit agent only for a plain subagent that should inherit the current model.",
    parameters: subagentSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as SubagentInput;
      return runSubagent(
        input.prompt,
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
