import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentSessionEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Model,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { type AgentConfig, discoverAgents } from "./agents";
import { formatTopLine } from "./render";

export const PER_TASK_OUTPUT_CAP = 32 * 1024;
export const SUBAGENT_TOOL_NAME = "subagent";

// A subagent attempt is considered stalled (and abandoned in favor of the
// next model candidate) after this long without any observable progress
// (session creation, a streamed message, or a tool call). This guards
// against nested-session setup hanging indefinitely — e.g. a provider
// extension's session_start hook blocking on a slow network call — which
// would otherwise require the user to manually abort. Set to 120s to
// accommodate reasoning models that pause for extended thinking before
// emitting their first token.
export const STALL_TIMEOUT_MS = 120_000;

// How many times to retry the same model candidate before falling back to
// the next one. Transient provider errors (empty_stream, connection resets)
// usually succeed on a quick retry, so this avoids unnecessary model
// fallbacks for flaky-but-recoverable failures.
export const MAX_SAME_MODEL_RETRIES = 2;

const inSubagent = new AsyncLocalStorage<true>();

export type SubagentUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly turns: number;
  readonly contextTokens: number | undefined;
};

export type SubagentToolCall = {
  readonly name: string;
  readonly title: string;
  readonly isError: boolean;
};

export type SubagentActiveTool = {
  readonly name: string;
  readonly title: string;
};

export type SubagentDetails = {
  readonly returnedOutput: string;
  readonly fullOutput: string;
  readonly outputTruncated: boolean;
  readonly omittedBytes: number;
  readonly usage: SubagentUsage;
  readonly toolCalls: readonly SubagentToolCall[];
  readonly activeToolCalls: readonly SubagentActiveTool[];
  readonly lastToolName: string | undefined;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly model: string | undefined;
  readonly contextWindow: number | undefined;
  readonly topLine: string;
};

export type SubagentSnapshot = {
  readonly finalOutput: string;
  readonly usage: SubagentUsage;
  readonly toolCalls: readonly SubagentToolCall[];
  readonly activeToolCalls: readonly SubagentActiveTool[];
  readonly lastToolName: string | undefined;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly model: string | undefined;
  readonly contextWindow: number | undefined;
};

export type SubagentSession = {
  readonly subscribe: (
    listener: (event: AgentSessionEvent) => void
  ) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
};

export type CreateSubagentSession = (
  parentCtx: ExtensionContext,
  activeToolNames: readonly string[] | undefined,
  agent: AgentConfig | undefined,
  model: Model<any> | undefined
) => Promise<SubagentSession>;

export function childToolNames(
  activeToolNames: readonly string[]
): readonly string[] {
  const tools = activeToolNames.filter((name) => name !== SUBAGENT_TOOL_NAME);
  if (!tools.includes("skill")) {
    tools.push("skill");
  }
  return tools;
}

export async function createSdkSubagentSession(
  parentCtx: ExtensionContext,
  activeToolNames: readonly string[] | undefined,
  agent: AgentConfig | undefined,
  model: Model<any> | undefined
): Promise<SubagentSession> {
  const systemPrompt = agent?.systemPrompt.trim();
  const loader = new DefaultResourceLoader({
    cwd: parentCtx.cwd,
    agentDir: getAgentDir(),
    appendSystemPrompt: systemPrompt ? [systemPrompt] : undefined,
  });
  await loader.reload();

  const baseTools = agent?.tools ?? activeToolNames;

  const { session } = await createAgentSession({
    cwd: parentCtx.cwd,
    agentDir: getAgentDir(),
    model,
    sessionManager: SessionManager.inMemory(parentCtx.cwd),
    resourceLoader: loader,
    tools: baseTools ? [...childToolNames(baseTools)] : undefined,
  });

  return session;
}

// Resolves the model candidates for a single "model" reference (no commas).
// When the reference names an id without a provider and that id is exposed
// by several providers, all authenticated candidates are returned (preferring
// the parent's current provider first) instead of failing, so callers can
// fall back across providers if the first candidate errors out.
// Returns an empty array when the reference is not found, so callers can
// skip it and try the next comma-separated fallback.
function resolveModelReference(
  parentCtx: ExtensionContext,
  reference: string
): readonly Model<any>[] {
  const normalized = reference.toLowerCase();
  const models = parentCtx.modelRegistry.getAll();
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized
  );
  if (canonical.length > 0) {
    return canonical;
  }

  const byId = models.filter((model) => model.id.toLowerCase() === normalized);
  if (byId.length === 0) {
    return [];
  }

  const authenticated = byId.filter((model) =>
    parentCtx.modelRegistry.hasConfiguredAuth(model)
  );
  const candidates = authenticated.length > 0 ? authenticated : byId;
  const currentProvider = parentCtx.model?.provider;
  return [...candidates].sort((a, b) => {
    const aCurrent = a.provider === currentProvider ? 0 : 1;
    const bCurrent = b.provider === currentProvider ? 0 : 1;
    return aCurrent - bCurrent;
  });
}

// Resolves the ordered list of model candidates to try for a subagent.
// The agent's "model" config may list multiple comma-separated references
// (e.g. "gemini-3.6-flash, deepseek-v4-flash"); each is tried in the declared order,
// and each reference itself may expand to several provider candidates when
// it names a bare model id shared by multiple authenticated providers.
export function resolveSubagentModelCandidates(
  parentCtx: ExtensionContext,
  agent: AgentConfig | undefined
): readonly Model<any>[] {
  const raw = agent?.model?.trim();
  if (!raw) {
    return parentCtx.model ? [parentCtx.model] : [];
  }

  const agentLabel = agent?.name ?? "configured";
  const references = raw
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);

  const seen = new Set<string>();
  const candidates: Model<any>[] = [];
  const missing: string[] = [];
  for (const reference of references) {
    const resolved = resolveModelReference(parentCtx, reference);
    if (resolved.length === 0) {
      missing.push(reference);
      continue;
    }
    for (const model of resolved) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push(model);
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `Unknown model "${missing.join(", ")}" for subagent "${agentLabel}". Use an exact model id or provider/model.`
    );
  }
  return candidates;
}

export function resolveSubagentModel(
  parentCtx: ExtensionContext,
  agent: AgentConfig | undefined
): Model<any> | undefined {
  return resolveSubagentModelCandidates(parentCtx, agent)[0];
}

function resolveAgent(
  agentName: string,
  agents: readonly AgentConfig[]
): AgentConfig {
  const normalized = agentName.trim().toLowerCase();
  const agent = agents.find((a) => a.name.toLowerCase() === normalized);
  if (agent) {
    return agent;
  }
  const available =
    agents.map((a) => `${a.name} (${a.source})`).join(", ") ||
    "none configured";
  throw new Error(`Unknown subagent "${agentName}". Available: ${available}.`);
}

function promptFor(prompt: string, agent: AgentConfig | undefined): string {
  return agent ? `Task: ${prompt}` : prompt;
}

export async function runSubagent(
  prompt: string,
  parentCtx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
  createSession: CreateSubagentSession = createSdkSubagentSession,
  activeToolNames?: readonly string[],
  agentName?: string,
  stallTimeoutMs: number = STALL_TIMEOUT_MS
): Promise<AgentToolResult<SubagentDetails>> {
  // Hard block against subagent recursion
  if (inSubagent.getStore()) {
    throw new Error("subagents cannot call subagent tool");
  }

  return inSubagent.run(true, async () => {
    const agent = agentName
      ? resolveAgent(agentName, await discoverAgents(parentCtx.cwd))
      : undefined;
    const candidates = resolveSubagentModelCandidates(parentCtx, agent);
    const models = candidates.length > 0 ? candidates : [undefined];

    for (let i = 0; i < models.length; i++) {
      const model = models[i];

      // Retry the same model candidate up to MAX_SAME_MODEL_RETRIES times
      // before falling back to the next candidate. Only retry transient
      // failures that occurred before any progress (no tool calls, no
      // turns completed) — these are typically provider-side hiccups
      // (empty_stream, connection resets, brief stalls) that resolve on
      // a quick retry. Once the subagent has made any progress, the
      // failure is considered non-transient and we don't retry.
      let attempt: SubagentAttemptResult | undefined;
      for (let r = 0; r <= MAX_SAME_MODEL_RETRIES; r++) {
        attempt = await runSubagentAttempt(
          prompt,
          parentCtx,
          agent,
          model,
          signal,
          onUpdate,
          createSession,
          activeToolNames,
          stallTimeoutMs
        );

        const failedBeforeAnyProgress =
          attempt.snapshot.toolCalls.length === 0 &&
          attempt.snapshot.usage.turns === 0 &&
          (attempt.thrown !== undefined ||
            attempt.snapshot.stopReason === "error" ||
            attempt.stalled);
        const hasMoreRetries = r < MAX_SAME_MODEL_RETRIES;

        if (!failedBeforeAnyProgress || !hasMoreRetries || signal?.aborted) {
          break;
        }
      }

      const finalAttempt = attempt!;
      const failedBeforeAnyProgress =
        finalAttempt.snapshot.toolCalls.length === 0 &&
        finalAttempt.snapshot.usage.turns === 0 &&
        (finalAttempt.thrown !== undefined ||
          finalAttempt.snapshot.stopReason === "error" ||
          finalAttempt.stalled);
      const hasMoreCandidates = i < models.length - 1;

      if (!failedBeforeAnyProgress || !hasMoreCandidates || signal?.aborted) {
        return finalizeAttempt(finalAttempt);
      }
    }

    // Unreachable: models always has at least one entry and the loop returns
    // on its last iteration.
    throw new Error("subagent: no model candidates to try");
  });
}

type SubagentAttemptResult = {
  readonly thrown: unknown;
  readonly snapshot: SubagentSnapshot;
  readonly capture: SubagentEventCapture;
  readonly stalled: boolean;
  readonly stallTimeoutMs: number;
};

async function runSubagentAttempt(
  prompt: string,
  parentCtx: ExtensionContext,
  agent: AgentConfig | undefined,
  model: Model<any> | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  createSession: CreateSubagentSession,
  activeToolNames: readonly string[] | undefined,
  stallTimeoutMs: number = STALL_TIMEOUT_MS
): Promise<SubagentAttemptResult> {
  const capture = new SubagentEventCapture(onUpdate, {
    contextWindow: model?.contextWindow,
    model: model?.id,
  });
  let session: SubagentSession | undefined;
  let thrown: unknown;
  let abortRequested = false;
  let stalled = false;
  let abortPromise: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  // ensureAbort must never let an exception escape synchronously: it's
  // called from an 'abort' event listener (onAbort), and event listeners
  // that throw synchronously are reported as uncaught exceptions rather
  // than being caught by the caller. session.abort() is async and its
  // rejections are already caught below, but the try/catch guards against
  // any synchronous throw from calling it in the first place.
  const ensureAbort = (): Promise<void> => {
    if (!session) {
      return Promise.resolve();
    }
    if (!abortPromise) {
      try {
        abortPromise = session.abort().catch(() => {});
      } catch {
        abortPromise = Promise.resolve();
      }
    }
    return abortPromise;
  };

  const onAbort = () => {
    try {
      abortRequested = true;
      void ensureAbort();
    } catch {
      // Never let the abort listener throw.
    }
  };

  const clearStallTimer = () => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };

  // Restarts the inactivity watchdog. Called before session creation and
  // after every session event, so a hung session (e.g. nested extension
  // setup blocking on a network call before the first turn even starts)
  // gets abandoned instead of hanging until the user manually aborts.
  const resetStallTimer = () => {
    clearStallTimer();
    stallTimer = setTimeout(() => {
      stalled = true;
      abortRequested = true;
      void ensureAbort();
    }, stallTimeoutMs);
    stallTimer.unref?.();
  };

  try {
    if (signal?.aborted) {
      abortRequested = true;
      throw new Error("subagent aborted before start");
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    resetStallTimer();
    session = await createSession(parentCtx, activeToolNames, agent, model);
    unsubscribe = session.subscribe((event) => {
      resetStallTimer();
      capture.handle(event);
    });
    if (abortRequested) {
      await ensureAbort();
      throw new Error(
        stalled
          ? "subagent stalled before start"
          : "subagent aborted before start"
      );
    }
    await session.prompt(promptFor(prompt, agent));

    // Some models (notably gemini-flash) complete all tool work but end
    // without producing any visible text — only thinking blocks. Nudge
    // the model to emit a text summary so the parent agent gets usable
    // results instead of an empty string.
    if (
      !abortRequested &&
      !signal?.aborted &&
      capture.snapshot().finalOutput === ""
    ) {
      await session.prompt(
        "Report your findings concisely as a text response. Do not call any tools."
      );
    }

    if (abortRequested && capture.snapshot().stopReason !== "aborted") {
      capture.markAborted();
    }
  } catch (err) {
    thrown = err;
  } finally {
    clearStallTimer();
    signal?.removeEventListener("abort", onAbort);
    if (abortRequested) {
      await ensureAbort();
    }
    unsubscribe?.();
    session?.dispose();
  }

  return {
    thrown,
    snapshot: capture.snapshot(),
    capture,
    stalled,
    stallTimeoutMs,
  };
}

function finalizeAttempt(
  attempt: SubagentAttemptResult
): AgentToolResult<SubagentDetails> {
  const { thrown, snapshot, capture, stalled, stallTimeoutMs } = attempt;
  if (stalled) {
    throw makeFailureError(
      "stalled",
      `no progress within ${stallTimeoutMs}ms; aborted to avoid hanging`,
      snapshot.finalOutput
    );
  }
  if (thrown !== undefined) {
    throw makeFailureError(
      thrownMessage(thrown),
      undefined,
      snapshot.finalOutput
    );
  }
  if (snapshot.stopReason === "error" || snapshot.stopReason === "aborted") {
    throw makeFailureError(
      snapshot.stopReason,
      snapshot.errorMessage,
      snapshot.finalOutput
    );
  }

  const details = capture.details();
  const text =
    details.returnedOutput || "[subagent tool: completed with no text output.]";
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export class SubagentEventCapture {
  private finalOutput = "";
  private pendingMessage: AssistantMessage | undefined;
  private readonly usage: MutableUsage = emptyUsage();
  private readonly toolCalls: SubagentToolCall[] = [];
  private readonly activeToolsById = new Map<string, SubagentActiveTool>();
  private lastToolName: string | undefined;
  private stopReason: string | undefined;
  private errorMessage: string | undefined;
  private model: string | undefined;

  public constructor(
    private readonly onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
    private readonly options: {
      readonly contextWindow?: number;
      readonly model?: string;
    } = {}
  ) {
    this.model = options.model;
  }

  public handle(event: AgentSessionEvent): void {
    if (event.type === "message_start" && isAssistantMessage(event.message)) {
      this.pendingMessage = undefined;
      this.emitUpdate();
      return;
    }

    if (event.type === "message_update" && isAssistantMessage(event.message)) {
      this.pendingMessage = event.message;
      return;
    }

    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      this.pendingMessage = undefined;
      const text = collectText(event.message);
      if (text) {
        this.finalOutput = text;
      }
      addUsage(this.usage, event.message.usage);
      this.usage.turns += 1;
      this.stopReason = event.message.stopReason;
      this.errorMessage = event.message.errorMessage;
      this.model = event.message.model;
      this.emitUpdate();
      return;
    }

    if (event.type === "tool_execution_start") {
      const title = deriveToolTitle(event.toolName, event.args);
      this.activeToolsById.set(event.toolCallId, {
        name: event.toolName,
        title,
      });
      this.lastToolName = event.toolName;
      this.emitUpdate();
      return;
    }

    if (event.type === "tool_execution_end") {
      const active = this.activeToolsById.get(event.toolCallId);
      const title = active?.title ?? "";
      this.activeToolsById.delete(event.toolCallId);
      this.toolCalls.push({
        name: event.toolName,
        title,
        isError: event.isError,
      });
      this.lastToolName = event.toolName;
      this.emitUpdate();
    }
  }

  public markAborted(): void {
    this.stopReason = "aborted";
    this.emitUpdate();
  }

  public snapshot(): SubagentSnapshot {
    this.materializePending();
    return {
      finalOutput: this.finalOutput,
      usage: freezeUsage(this.usage),
      toolCalls: [...this.toolCalls],
      activeToolCalls: Array.from(this.activeToolsById.values()),
      lastToolName: this.lastToolName,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      model: this.model,
      contextWindow: this.options.contextWindow,
    };
  }

  public details(): SubagentDetails {
    const snapshot = this.snapshot();
    const cap = applyOutputCap(snapshot.finalOutput);
    return detailsFromSnapshot(snapshot, cap.text, cap);
  }

  private materializePending(): void {
    if (this.pendingMessage) {
      const text = collectText(this.pendingMessage);
      if (text) {
        this.finalOutput = text;
      }
      this.pendingMessage = undefined;
    }
  }

  private emitUpdate(): void {
    if (!this.onUpdate) {
      return;
    }
    const details = this.details();
    this.onUpdate({
      content: [{ type: "text", text: details.topLine }],
      details,
    });
  }
}

type MutableUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  contextTokens: number | undefined;
};

export type OutputCapResult = {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
};

export function applyOutputCap(
  text: string,
  capBytes = PER_TASK_OUTPUT_CAP
): OutputCapResult {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(text).byteLength;
  if (totalBytes <= capBytes) {
    return { text, truncated: false, omittedBytes: 0 };
  }

  const buffer = new Uint8Array(capBytes);
  const { read, written } = encoder.encodeInto(text, buffer);
  const out = text.slice(0, read);
  const omittedBytes = totalBytes - written;
  return {
    text: `${out}\n[subagent: output truncated, ${omittedBytes} bytes omitted; full output preserved in tool details.]`,
    truncated: true,
    omittedBytes,
  };
}

function makeFailureError(
  reason: string,
  errorMessage: string | undefined,
  partialOutput: string
): Error {
  const capped = applyOutputCap(partialOutput);
  return new Error(
    `Subagent failed: ${reason}. Error: ${errorMessage ?? "none"}.\n` +
      `Partial output before failure:\n${capped.text}`
  );
}

function detailsFromSnapshot(
  snapshot: SubagentSnapshot,
  returnedOutput: string,
  capResult: OutputCapResult
): SubagentDetails {
  return {
    returnedOutput,
    fullOutput: snapshot.finalOutput,
    outputTruncated: capResult.truncated,
    omittedBytes: capResult.omittedBytes,
    usage: snapshot.usage,
    toolCalls: snapshot.toolCalls,
    activeToolCalls: snapshot.activeToolCalls,
    lastToolName: snapshot.lastToolName,
    stopReason: snapshot.stopReason,
    errorMessage: snapshot.errorMessage,
    model: snapshot.model,
    contextWindow: snapshot.contextWindow,
    topLine: formatTopLine(snapshot),
  };
}

function collectText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "content" in message &&
    Array.isArray(message.content)
  );
}

function emptyUsage(): MutableUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    contextTokens: undefined,
  };
}

function freezeUsage(usage: MutableUsage): SubagentUsage {
  return { ...usage };
}

function addUsage(target: MutableUsage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost.total;
  target.contextTokens = usage.totalTokens || target.contextTokens;
}

function thrownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deriveToolTitle(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const a = args as Record<string, unknown>;
  const name = toolName.toLowerCase();
  const firstLine = (value: unknown): string =>
    String(value ?? "")
      .split(/\r?\n/u)[0]
      ?.trim()
      .slice(0, 120) ?? "";

  if (name === "read") {
    const path = firstLine(a.path);
    const range = formatRangeField(a.start, a.end);
    return path ? `${path}${range}` : "";
  }
  if (name === "glob") {
    return firstLine(a.pattern);
  }
  if (name === "grep") {
    const pattern = firstLine(a.pattern);
    return pattern ? `/${pattern}/` : "";
  }
  if (name === "bash") {
    return firstLine(a.command);
  }
  if (name === "write" || name === "edit") {
    return firstLine(a.path);
  }
  if (name === "search" || name === "web_search") {
    return firstLine(a.query ?? a.task);
  }
  if (name === "todo") {
    return "update todo";
  }
  if (name === "subagent") {
    const agent = firstLine(a.agent);
    const prompt = firstLine(a.prompt);
    return [agent, prompt].filter(Boolean).join(" ");
  }
  return firstLine(a.path ?? a.pattern ?? a.query ?? a.command ?? a.prompt);
}

function formatRangeField(start: unknown, end: unknown): string {
  const s = typeof start === "number" ? start : undefined;
  const e = typeof end === "number" ? end : undefined;
  if (s === undefined && e === undefined) {
    return "";
  }
  if (e === undefined) {
    return ` @${s}`;
  }
  return ` @${s ?? 1}-${e}`;
}
