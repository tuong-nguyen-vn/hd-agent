import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerSkill, {
  collectClaudeSkillDirs,
  findSkill,
  parseSkillEntries,
  transformSkillCommand,
  type SkillEntry,
} from "./index";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const entries: SkillEntry[] = [
  {
    name: "agent-browser",
    description: "Automate browser tasks",
    filePath: "/skills/agent-browser/SKILL.md",
  },
  {
    name: "tldraw-offline",
    description: "Operate a tldraw canvas",
    filePath: "/skills/tldraw-offline/SKILL.md",
  },
];

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerSkill({
    on(): void {},
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);
  if (!tool) {
    throw new Error("skill tool was not registered");
  }
  return tool;
}

function skillPrompt(filePath: string): string {
  return `<available_skills>
  <skill>
    <name>agent-browser</name>
    <description>Automate browser tasks</description>
    <location>${filePath}</location>
  </skill>
</available_skills>`;
}

function context(systemPrompt: string, sessionManager: object): ExtensionContext {
  return {
    getSystemPrompt: () => systemPrompt,
    sessionManager,
  } as ExtensionContext;
}

function makeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), "pim-skill-"));
  tempDirs.push(dir);
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    "---\nname: agent-browser\ndescription: Automate browser tasks\n---\n\n# Browser workflow\nRun the browser workflow.\n"
  );
  return path;
}

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const renderContext = {
  args: { name: "agent beowser" },
  state: {},
  toolCallId: "skill-1",
  cwd: "/repo",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: true,
  isError: false,
  lastComponent: undefined,
  invalidate: () => {},
};

describe("skill discovery", () => {
  test("discovers global and ancestor .claude skill directories", () => {
    const root = mkdtempSync(join(tmpdir(), "pim-claude-skills-"));
    tempDirs.push(root);
    const home = join(root, "home");
    const repo = join(root, "repo");
    const nested = join(repo, "packages", "app");
    const globalSkills = join(home, ".claude", "skills");
    const repoSkills = join(repo, ".claude", "skills");
    const nestedSkills = join(nested, ".claude", "skills");
    for (const dir of [
      globalSkills,
      repoSkills,
      nestedSkills,
      join(repo, ".git"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    expect(collectClaudeSkillDirs(nested, home, true)).toEqual([
      nestedSkills,
      repoSkills,
      globalSkills,
    ]);
    expect(collectClaudeSkillDirs(nested, home, false)).toEqual([
      globalSkills,
    ]);
  });

  test("parses available skill entries from the system prompt", () => {
    expect(
      parseSkillEntries(`<available_skills>
        <skill>
          <name>agent-browser</name>
          <description>Automate browser tasks\nand Electron apps</description>
          <location>/skills/agent-browser/SKILL.md</location>
        </skill>
      </available_skills>`)
    ).toEqual([
      {
        name: "agent-browser",
        description: "Automate browser tasks\nand Electron apps",
        filePath: "/skills/agent-browser/SKILL.md",
      },
    ]);
  });

  test("matches spaces, partial names, and small typos", () => {
    expect(findSkill("agent browser", entries)?.name).toBe("agent-browser");
    expect(findSkill("tldraw", entries)?.name).toBe("tldraw-offline");
    expect(findSkill("agent beowser", entries)?.name).toBe("agent-browser");
    expect(findSkill("daw office", entries)).toBeUndefined();
  });
});

describe("skill slash command", () => {
  test("routes /skill:name through the skill tool instead of built-in expansion", () => {
    expect(transformSkillCommand("/skill:agent-browser")).toBe(
      'Invoke the "agent-browser" skill using the skill tool before responding.'
    );
    expect(
      transformSkillCommand("/skill:agent-browser open the dashboard")
    ).toBe(
      'Invoke the "agent-browser" skill using the skill tool before responding.\n\nThen handle this request:\nopen the dashboard'
    );
    expect(transformSkillCommand("load skill agent-browser")).toBeUndefined();
  });
});

describe("skill tool", () => {
  test("registers invocation guidance for the model", () => {
    const tool = registeredTool();
    expect(tool.name).toBe("skill");
    expect(tool.executionMode).toBe("parallel");
    expect(tool.promptSnippet).toBe("Invoke an installed skill");
    expect(tool.description).toContain("Do not use read on SKILL.md directly");
    expect(tool.promptGuidelines).toContain(
      "When a task matches an entry in <available_skills>, call the skill tool before acting."
    );
  });

  test("loads once per session but loads independently in another session", async () => {
    const tool = registeredTool();
    const filePath = makeSkill();
    const prompt = skillPrompt(filePath);
    const parentSession = {};
    const subagentSession = {};

    const first = await tool.execute(
      "1",
      { name: "agent beowser" },
      undefined,
      undefined,
      context(prompt, parentSession)
    );
    const repeated = await tool.execute(
      "2",
      { name: "agent-browser" },
      undefined,
      undefined,
      context(prompt, parentSession)
    );
    const subagent = await tool.execute(
      "3",
      { name: "agent-browser" },
      undefined,
      undefined,
      context(prompt, subagentSession)
    );

    expect(first.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("# Browser workflow"),
    });
    expect(repeated.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("already active in this session"),
    });
    expect(subagent.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("# Browser workflow"),
    });
  });

  test("returns suggestions without reading a skill file", async () => {
    const tool = registeredTool();
    const result = await tool.execute(
      "1",
      { name: "daw office" },
      undefined,
      undefined,
      context(
        `<available_skills>
          <skill><name>agent-browser</name><description>Automate browser apps</description><location>/missing/browser.md</location></skill>
          <skill><name>tldraw-offline</name><description>Operate tldraw</description><location>/missing/tldraw.md</location></skill>
        </available_skills>`,
        {}
      )
    );

    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (!content || content.type !== "text") {
      throw new Error("expected text content");
    }
    expect(content.text).toContain("Did you mean:");
    expect(content.text).toContain("tldraw-offline");
  });

  test("renders the resolved invocation name", async () => {
    const tool = registeredTool();
    const filePath = makeSkill();
    const state = {};
    const call = tool.renderCall!(
      { name: "agent beowser" },
      stubTheme,
      { ...renderContext, state }
    );
    expect(call.render(120).join("\n")).toContain(
      "✓ Invoked skill agent beowser"
    );

    const result = await tool.execute(
      "1",
      { name: "agent beowser" },
      undefined,
      undefined,
      context(skillPrompt(filePath), {})
    );
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      stubTheme,
      { ...renderContext, state }
    );
    expect(call.render(120).join("\n")).toContain(
      "✓ Invoked skill agent-browser"
    );
  });

  test("renders a spinner while running and a cross on error", () => {
    const tool = registeredTool();
    const partial = tool.renderCall!(
      { name: "agent-browser" },
      stubTheme,
      {
        ...renderContext,
        state: {},
        isPartial: true,
        invalidate: () => {},
      }
    );
    expect(partial.render(120).join("\n")).toContain(
      "⣿ Invoked skill agent-browser"
    );

    const failed = tool.renderCall!(
      { name: "agent-browser" },
      stubTheme,
      { ...renderContext, state: {}, isError: true }
    );
    expect(failed.render(120).join("\n")).toContain(
      "✗ Invoked skill agent-browser"
    );
  });
});
