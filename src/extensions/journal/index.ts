import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { JournalLine } from "../../shared/JournalLine";
import { Tools } from "../../shared/Tools";
import { buildAuditPrompt, sampleForAudit } from "./audit";
import { JournalIndexer, type JournalSearchResult } from "./indexer";
import { isMemoryEnabled, setMemoryEnabled } from "./state";

const journalSearchSchema = Type.Object({
  query: Type.String({
    description: "Keyword search over the user's past prompts",
  }),
  limit: Type.Optional(
    Type.Number({ description: "Maximum results, default 10" })
  ),
});

type JournalSearchInput = Static<typeof journalSearchSchema>;

function formatResults(results: JournalSearchResult[]): string {
  if (results.length === 0) {
    return "No matching prompts found in the journal.";
  }
  return results
    .map((r, i) => {
      const date = r.timestamp.slice(0, 10);
      return `${i + 1}. [${date}] (${r.cwd}) ${r.text.slice(0, 200)}`;
    })
    .join("\n");
}

export default function (pi: ExtensionAPI): void {
  let indexer: JournalIndexer | undefined;

  const getIndexer = (): JournalIndexer => {
    indexer ??= new JournalIndexer();
    return indexer;
  };

  const refreshIndicator = (ctx: ExtensionContext): void => {
    JournalLine.setText(isMemoryEnabled() ? "mem" : "mem off");
    void ctx;
  };

  const toggleMemory = (ctx: ExtensionContext): void => {
    const next = !isMemoryEnabled();
    setMemoryEnabled(next);
    refreshIndicator(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        next
          ? "Memory indexing on"
          : "Memory indexing off — existing journal stays searchable",
        "info"
      );
    }
  };

  pi.on("session_start", (_event, ctx) => {
    JournalLine.setOnToggle(() => toggleMemory(ctx));
    refreshIndicator(ctx);
    if (!isMemoryEnabled()) {
      return;
    }
    // Fire-and-forget incremental pass: sessions are append-only, so only
    // new bytes are read. Never block or break the session over indexing.
    void getIndexer()
      .indexSessions()
      .catch(() => {
        ctx.ui.notify(
          "Usage: /memory [on|off|recall <query>|audit [topic]]",
          "warning"
        );
      });
  });

  pi.on("session_shutdown", () => {
    JournalLine.setText(undefined);
    JournalLine.setOnToggle(undefined);
    indexer?.close();
    indexer = undefined;
  });

  Tools.register<typeof journalSearchSchema>(pi, {
    name: "journal_search",
    label: "journal search",
    description:
      "Search the user's own past prompts across all previous sessions in every project " +
      "(their private memory journal). Use when the user references something they asked " +
      "before, how they asked it, or wants to recall past requests — e.g. 'what did I ask " +
      "about X', 'tôi từng yêu cầu gì về X'. Returns matching prompts with timestamps, " +
      "project paths, and session references. The current project's matches rank first.",
    parameters: journalSearchSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as JournalSearchInput;
      const results = getIndexer().search(
        input.query,
        input.limit ?? 10,
        ctx.cwd
      );
      const stale = isMemoryEnabled()
        ? ""
        : "\n(Note: memory indexing is currently off — recent prompts may be missing.)";
      return {
        content: [{ type: "text", text: formatResults(results) + stale }],
        details: { count: results.length },
      };
    },
  });

  pi.registerCommand("memory", {
    description:
      "Memory journal: /memory [on|off] toggles indexing, /memory recall <query> searches past prompts, /memory audit [topic] analyzes recurring patterns",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "";

      if (sub === "on" || sub === "off") {
        setMemoryEnabled(sub === "on");
        refreshIndicator(ctx);
        ctx.ui.notify(`Memory indexing ${sub === "on" ? "on" : "off"}`, "info");
        return;
      }

      if (sub === "audit") {
        const topic = parts.slice(1).join(" ").trim() || undefined;
        const samples = sampleForAudit(
          (q, l) => getIndexer().search(q, l, ctx.cwd),
          (l) => getIndexer().recent(l),
          topic
        );
        if (samples.length === 0) {
          ctx.ui.notify(
            "Journal is empty — nothing to audit yet. Memory indexes your prompts as you work.",
            "info"
          );
          return;
        }
        pi.sendUserMessage(buildAuditPrompt(samples, topic));
        return;
      }

      if (sub === "recall") {
        const query = parts.slice(1).join(" ").trim();
        if (!query) {
          ctx.ui.notify("Usage: /memory recall <query>", "warning");
          return;
        }
        const results = getIndexer().search(query, 10, ctx.cwd);
        pi.sendMessage(
          {
            customType: "journal-recall",
            content: `Memory recall for "${query}":\n\n${formatResults(results)}`,
            display: true,
          },
          { triggerTurn: false }
        );
        return;
      }

      if (sub === "") {
        toggleMemory(ctx);
        return;
      }

      ctx.ui.notify("Usage: /memory [on|off|recall <query>]", "warning");
    },
  });
}
