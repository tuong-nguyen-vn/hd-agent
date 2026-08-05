import { type Static, Type } from "typebox";

export const subagentSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Name of a predefined agent from ~/.pi/agent/agents or the project's .pi/agents. " +
        'Use "Search" for broad codebase discovery (finding files, symbols, and patterns across the codebase). ' +
        'Use "Oracle" for code reviews and architecture feedback, finding difficult bugs in codepaths that flow across many files, planning complex implementations or refactors, answering complex technical questions that require deep reasoning, or providing an alternative point of view when struggling. ' +
        'Do NOT use "Oracle" for file reads, simple keyword searches, web browsing, or basic code modifications — handle those directly. ' +
        "Include relevant findings, constraints, and file paths in the prompt without copying unrelated session history. " +
        "Omit only for a plain isolated subagent that should inherit the current model, prompt, and active tools.",
    })
  ),
  prompt: Type.String({
    minLength: 1,
    description:
      "The task for the subagent. For Oracle, include a compact delegation brief: Objective, Scope/files, Known findings with evidence, Constraints, and Questions/decisions. Do not copy unrelated session history.",
  }),
});

export type SubagentInput = Static<typeof subagentSchema>;
