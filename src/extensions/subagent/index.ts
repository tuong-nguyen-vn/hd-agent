import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Jobs } from "../../shared/Jobs";
import { Tools } from "../../shared/Tools";
import { buildSubagentPrompt } from "./context";
import { renderCall, renderResult } from "./render";
import { subagentSchema, type SubagentInput } from "./schema";
import {
  prewarmSubagentLoader,
  runSubagent,
  type SubagentDetails,
} from "./subagent";
import { markSessionActive, notifyBackgroundCompletion } from "./notifications";

// Deferred so the jiti compile pass runs after the session's initial paint
// and setup instead of competing with them for the event loop.
const PREWARM_DELAY_MS = 3_000;
let activeSessionFile: string | undefined;

// Indirection so tests can observe the background path without a real
// nested session. Production always uses runSubagent itself.
let runSubagentForTool: typeof runSubagent = runSubagent;

export function setRunSubagentForTests(
  fn: typeof runSubagent | undefined
): void {
  runSubagentForTool = fn ?? runSubagent;
}

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
    activeSessionFile = ctx.sessionManager?.getSessionFile();
    markSessionActive(activeSessionFile);
    cancelPrewarm();
    prewarmTimer = setTimeout(() => {
      prewarmTimer = undefined;
      void prewarmSubagentLoader(cwd);
    }, PREWARM_DELAY_MS);
    prewarmTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    cancelPrewarm();
  });

  Tools.register<typeof subagentSchema, SubagentDetails>(pi, {
    name: "subagent",
    label: "subagent",
    description:
      "Run a task in an isolated subagent with a fresh context. " +
      "The subagent inherits the currently active tools, except subagent itself. " +
      "Multiple subagent calls in one turn run in parallel. " +
      "Subagent output returned to the main agent is capped at 32KB. " +
      'Set "background" to true to launch without waiting: the tool returns a job id immediately, ' +
      "the result is delivered back to this session when the subagent finishes (or read it via the jobs tool). " +
      "Background subagents live only while this process runs. " +
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

      if (input.background) {
        return startBackgroundSubagent(pi, {
          prompt,
          rawPrompt: input.prompt,
          ctx,
          agentName: input.agent,
          run: runSubagentForTool,
          sessionFile: ctx.sessionManager?.getSessionFile(),
        });
      }

      return runSubagentForTool(
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

// The background path owns its AbortController: the caller's tool signal
// ends when this tool result returns, while the child keeps running.
export type BackgroundSubagentRun = typeof runSubagent;

function startBackgroundSubagent(
  pi: ExtensionAPI,
  args: {
    readonly prompt: string;
    readonly rawPrompt: string;
    readonly ctx: Parameters<typeof runSubagent>[1];
    readonly agentName: string | undefined;
    readonly run: BackgroundSubagentRun;
    readonly sessionFile: string | undefined;
  }
): AgentToolResult<SubagentDetails> {
  const controller = new AbortController();
  const sessionFile = args.sessionFile;
  const job = Jobs.create({
    kind: "subagent",
    title:
      (args.agentName ? `${args.agentName}: ` : "") +
      args.rawPrompt.split("\n", 1)[0]!.slice(0, 120),
    onCancel: () => controller.abort(),
  });

  void args
    .run(
      args.prompt,
      args.ctx,
      controller.signal,
      undefined,
      undefined,
      pi.getActiveTools(),
      args.agentName
    )
    .then(
      (result) => {
        const text = result.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        Jobs.setStatus(job.id, "completed", {
          exitCode: 0,
          output: { text: text.slice(0, 32_768) },
        });
        notifyBackgroundCompletion(pi, sessionFile, job.id);
        notify(pi, job.id, "completed", text);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const jobAfter = Jobs.get(job.id);
        // Jobs.cancel already marked it cancelled; only report failures for
        // runs the job system still considers running.
        if (jobAfter?.status === "running") {
          Jobs.setStatus(job.id, "failed", {
            error: message,
            output: { text: message.slice(0, 8_192) },
          });
          notify(pi, job.id, "failed", message);
        }
      }
    );

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Started background subagent ${job.id}. It runs while this process lives; ` +
          `its result is delivered to this session on completion, or read it via ` +
          `the jobs tool (action: status/output/kill, id: "${job.id}").`,
      },
    ],
    details: {
      returnedOutput: `background job ${job.id}`,
      fullOutput: "",
      outputTruncated: false,
      omittedBytes: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
        contextTokens: undefined,
      },
      toolCalls: [],
      activeToolCalls: [],
      lastToolName: undefined,
      stopReason: undefined,
      errorMessage: undefined,
      model: undefined,
      contextWindow: undefined,
      topLine: `background ${job.id}`,
    } satisfies SubagentDetails,
  };
}

function notify(
  pi: ExtensionAPI,
  jobId: string,
  status: "completed" | "failed",
  output: string
): void {
  // Custom message + triggerTurn: lands as queued follow-up when the parent
  // is mid-turn, wakes it when idle. 32KB mirrors the foreground result cap.
  try {
    pi.sendMessage(
      {
        customType: "subagent-report",
        content: `Background subagent ${jobId} ${status}.\n\n${output}`.slice(
          0,
          32_768
        ),
        display: true,
        details: { jobId, status },
      },
      { triggerTurn: true }
    );
  } catch {
    // A torn-down session invalidates sendMessage; the job result is still
    // inspectable through the jobs tool.
  }
}
