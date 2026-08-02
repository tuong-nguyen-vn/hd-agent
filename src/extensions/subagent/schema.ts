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
  }),
});

export type SubagentInput = Static<typeof subagentSchema>;
