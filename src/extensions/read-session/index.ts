import type {
  ExtensionAPI,
  ExtensionContext,
  FileEntry,
  SessionEntry,
  SessionInfo,
  Theme,
  buildSessionContext as BuildSessionContext,
  migrateSessionEntries as MigrateSessionEntries,
  parseSessionEntries as ParseSessionEntries,
  SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  Renderer,
  type StatefulToolCallTitleContext,
} from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { type ReadSessionInput, readSessionSchema } from "./schema";
import { summarizeSession, type SummaryResult } from "./summarize";
import { buildTranscript } from "./transcript";

const PREVIEW_LINES = 12;

export type ReadSessionDetails = {
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly modifiedAt: string;
  readonly model: string;
  readonly usedFallback: boolean;
  readonly transcriptTruncated: boolean;
};

type ReadSessionDeps = {
  readonly listSessions: (
    cwd: string,
    sessionDir: string
  ) => Promise<SessionInfo[]>;
  readonly readSession: (
    path: string,
    expectedId: string
  ) => Promise<AgentMessage[]>;
  readonly summarize: (
    transcript: string,
    ctx: ExtensionContext,
    signal?: AbortSignal
  ) => Promise<SummaryResult>;
};

const defaultDeps: ReadSessionDeps = {
  listSessions: async (cwd, sessionDir) => {
    const { SessionManager } =
      (await import("@earendil-works/pi-coding-agent")) as {
        SessionManager: typeof SessionManagerType;
      };
    return SessionManager.list(cwd, sessionDir);
  },
  readSession: async (path, expectedId) => {
    const { parseSessionEntries, migrateSessionEntries, buildSessionContext } =
      (await import("@earendil-works/pi-coding-agent")) as {
        parseSessionEntries: typeof ParseSessionEntries;
        migrateSessionEntries: typeof MigrateSessionEntries;
        buildSessionContext: typeof BuildSessionContext;
      };
    const entries = parseSessionEntries(
      await Bun.file(path).text()
    ) as FileEntry[];
    migrateSessionEntries(entries);
    const header = entries[0];
    if (header?.type !== "session" || header.id !== expectedId) {
      throw new Error(
        `Session "${expectedId}" could not be verified because its file header has a different ID.`
      );
    }
    return buildSessionContext(
      entries.filter((entry): entry is SessionEntry => entry.type !== "session")
    ).messages;
  },
  summarize: summarizeSession,
};

export async function executeReadSession(
  input: ReadSessionInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  deps: ReadSessionDeps = defaultDeps
) {
  if (signal?.aborted) {
    throw new Error("read_session aborted before execution.");
  }
  const id = input.id.trim();
  const currentId = ctx.sessionManager.getSessionId();
  if (id === currentId) {
    throw new Error(
      `Session "${id}" is the current session. Choose a previous session from the @@ picker.`
    );
  }

  const sessions = await deps.listSessions(
    ctx.cwd,
    ctx.sessionManager.getSessionDir()
  );
  const match = sessions.find((session) => session.id === id);
  if (!match) {
    throw new Error(
      `Session "${id}" was not found in the current workspace. Type @@ to choose an available session.`
    );
  }

  const transcript = buildTranscript(await deps.readSession(match.path, id));
  if (!transcript.text.trim()) {
    throw new Error(`Session "${id}" has no readable conversation content.`);
  }
  const summary = await deps.summarize(transcript.text, ctx, signal);

  return {
    content: [{ type: "text" as const, text: summary.text }],
    details: {
      sessionId: id,
      ...(match.name ? { sessionName: match.name } : {}),
      modifiedAt: match.modified.toISOString(),
      model: summary.model,
      usedFallback: summary.usedFallback,
      transcriptTruncated: transcript.truncated,
    } satisfies ReadSessionDetails,
  };
}

function renderTitle(
  input: Partial<ReadSessionInput>,
  theme: Theme,
  context: StatefulToolCallTitleContext
) {
  const markerColor = Renderer.markerColorFor(
    Boolean(context.isPartial),
    Boolean(context.isError)
  );
  const shortId = input.id ? input.id.slice(0, 12) : "...";
  return Renderer.renderStatefulToolCallTitle({
    label: "read_session",
    title: theme.fg("muted", shortId),
    theme,
    context,
    markerGlyph: Renderer.markerGlyphFor(markerColor),
    separator: " ",
    useSpinner: true,
  });
}

export default function (pi: ExtensionAPI): void {
  Tools.register<typeof readSessionSchema, ReadSessionDetails>(pi, {
    name: "read_session",
    label: "read_session",
    description:
      "Read and summarize one previous Pi session from the current workspace. " +
      "When the user includes an @@session:<id> reference, call this tool with that exact ID before answering anything that depends on the referenced work. " +
      "The summary covers the session's active branch and reports completed work, decisions, verification, and remaining tasks.",
    promptSnippet:
      "Summarize a previous workspace session referenced as @@session:<id>",
    promptGuidelines: [
      "When the user references @@session:<id>, call read_session with that exact ID before relying on the referenced session.",
    ],
    parameters: readSessionSchema,
    renderShell: "self",
    executionMode: "parallel",
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeReadSession(params as ReadSessionInput, ctx, signal);
    },
    renderCall(args, theme, context) {
      return renderTitle(
        (args ?? {}) as Partial<ReadSessionInput>,
        theme,
        context
      );
    },
    renderResult(result, options, theme, context) {
      renderTitle(context.args ?? {}, theme, context);
      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: PREVIEW_LINES,
      });
    },
  });
}
