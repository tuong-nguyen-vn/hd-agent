import { type Static, Type } from "typebox";

export const subagentSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Name of a predefined agent from ~/.pi/agent/agents or the project's .pi/agents. " +
        'Use "Search" for broad codebase discovery (finding files, symbols, and patterns across the codebase). ' +
        'Use "Oracle" for code reviews and architecture feedback, finding difficult bugs in codepaths that flow across many files, planning complex implementations or refactors, answering complex technical questions that require deep reasoning, or providing an alternative point of view when struggling. ' +
        'Do NOT use "Oracle" for file reads, simple keyword searches, web browsing, or basic code modifications — handle those directly. ' +
        "Omit only for a plain isolated subagent that should inherit the current model, prompt, and active tools.",
    })
  ),
  prompt: Type.String({
    minLength: 1,
    description:
      "The task for the subagent. For Oracle, write a self-contained delegation brief: Objective, Scope/files, Known findings with evidence (quoted excerpts cited as path:line), Constraints, and Questions/decisions. " +
      "Inline the evidence the subagent needs and pass supporting source files via context_paths instead of expecting it to rediscover them; it starts with a fresh context and no parent history. " +
      "Do not copy unrelated session history.",
  }),
  context_paths: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        "Source files to inline into the subagent's prompt, each as a path optionally suffixed with a 1-based line range " +
        '("src/foo.ts" or "src/foo.ts:120-260"). Relative paths resolve against the project root. ' +
        "Contents are read at call time and appended with line numbers. Hard caps: 50KB per entry, 150KB total — oversized calls fail without running, so pass line ranges for large files. " +
        "Use this to hand the subagent — especially Oracle — the exact source it needs so it can answer without re-reading files.",
    })
  ),
});

export type SubagentInput = Static<typeof subagentSchema>;
