import { describe, expect, test } from "bun:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import registerSystemPrompt, { formatSkillsForAmpPrompt } from "./index";

const skill: Skill = {
  name: "agent-browser",
  description: "Automate browser tasks",
  filePath: "/skills/agent-browser/SKILL.md",
  baseDir: "/skills/agent-browser",
  sourceInfo: {
    path: "/skills/agent-browser/SKILL.md",
    source: "test",
    scope: "temporary",
    origin: "top-level",
  },
  disableModelInvocation: false,
};

describe("formatSkillsForAmpPrompt", () => {
  test("directs the model to invoke the skill tool instead of reading SKILL.md", async () => {
    const prompt = await formatSkillsForAmpPrompt([skill]);

    expect(prompt).toContain(
      "Use the skill tool to invoke a skill when the task matches its description."
    );
    expect(prompt).toContain("Do not read SKILL.md directly.");
    expect(prompt).not.toContain(
      "Use the read tool to load a skill's file when the task matches its description."
    );
    expect(prompt).toContain("<name>agent-browser</name>");
    expect(prompt).toContain(
      "<location>/skills/agent-browser/SKILL.md</location>"
    );
  });
});

type PromptOptions = BeforeAgentStartEvent["systemPromptOptions"];
type Handler = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext
) => Promise<unknown>;

function promptOptions(overrides: Partial<PromptOptions> = {}): PromptOptions {
  return {
    selectedTools: ["read", "skill"],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {
      read: ["Read before editing."],
      skill: ["Invoke skills by name."],
      inactive: ["Never shown."],
    },
    promptGuidelines: ["Read before editing.", "Extra guideline."],
    appendSystemPrompt: "",
    sections: {},
    cwd: "/repo",
    contextFiles: [],
    skills: [],
    ...overrides,
  };
}

async function runHandler(options: PromptOptions): Promise<void> {
  let handler: Handler | undefined;
  const pi = {
    on: (event: string, cb: Handler) => {
      if (event === "before_agent_start") {
        handler = cb;
      }
    },
  } as unknown as ExtensionAPI;
  registerSystemPrompt(pi);
  await handler?.(
    { systemPromptOptions: options } as BeforeAgentStartEvent,
    { model: undefined } as ExtensionContext
  );
}

describe("before_agent_start", () => {
  test("includes the guidelines of selected tools once", async () => {
    const options = promptOptions();
    await runHandler(options);
    const prompt = options.forceSystemPrompt ?? "";

    expect(prompt).toContain("- Invoke skills by name.");
    expect(prompt).toContain("- Extra guideline.");
    expect(prompt).not.toContain("Never shown.");
    expect(prompt.split("Read before editing.")).toHaveLength(2);
  });

  test("leaves out the guidelines of hidden tools", async () => {
    const options = promptOptions({ hiddenTools: ["skill"] });
    await runHandler(options);
    const prompt = options.forceSystemPrompt ?? "";

    expect(prompt).toContain("- Read before editing.");
    expect(prompt).not.toContain("Invoke skills by name.");
  });

  test("carries sections that later handlers add", async () => {
    const options = promptOptions();
    await runHandler(options);
    options.sections["mcp_servers"] = "- docs: product docs";

    expect(options.forceSystemPrompt).toEndWith(
      "<mcp_servers>\n- docs: product docs\n</mcp_servers>"
    );
  });

  test("lets a later systemPrompt override win", async () => {
    const options = promptOptions();
    await runHandler(options);
    options.forceSystemPrompt = "custom";

    expect(options.forceSystemPrompt).toBe("custom");
    expect({ ...options }.forceSystemPrompt).toBe("custom");
  });
});
