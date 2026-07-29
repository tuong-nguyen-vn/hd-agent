import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { buildTranscript } from "../read-session/transcript";
import { generateSessionTitle } from "./generateTitle";

// Small transcript budget: titling only needs the gist of the session, and
// keeping it short makes the (typically cheap/fast) title model quick.
const TITLE_TRANSCRIPT_MAX_CHARS = 8_000;

/**
 * Auto-names sessions with an LLM once there's enough conversation to
 * summarize, mirroring read_session's model fallback (configurable model
 * list, then the main agent's current model). Never overrides a name the
 * user set explicitly via /name or --name.
 */
export default function (pi: ExtensionAPI): void {
  let generating = false;
  let attemptedSessionId: string | undefined;

  const maybeGenerateTitle = async (ctx: ExtensionContext): Promise<void> => {
    if (generating || ctx.sessionManager.getSessionName()) {
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    if (attemptedSessionId === sessionId) {
      return;
    }

    const entries = ctx.sessionManager.buildContextEntries();
    const { messages } = buildSessionContext(entries);
    const hasExchange =
      messages.some((m) => m.role === "user") &&
      messages.some((m) => m.role === "assistant");
    if (!hasExchange) {
      return;
    }

    const transcript = buildTranscript(
      messages,
      TITLE_TRANSCRIPT_MAX_CHARS
    ).text;
    if (!transcript.trim()) {
      return;
    }

    generating = true;
    attemptedSessionId = sessionId;
    try {
      const title = await generateSessionTitle(transcript, ctx);
      if (title && !ctx.sessionManager.getSessionName()) {
        pi.setSessionName(title);
      }
    } catch {
      // Best-effort: leave the session unnamed on failure.
    } finally {
      generating = false;
    }
  };

  pi.on("agent_settled", (_event, ctx) => {
    void maybeGenerateTitle(ctx);
  });
}
