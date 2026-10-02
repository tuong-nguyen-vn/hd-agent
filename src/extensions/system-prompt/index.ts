import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  formatSkillsForPrompt as FormatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "./prompt";

type SkillsParam = Parameters<typeof FormatSkillsForPrompt>[0];

export async function formatSkillsForAmpPrompt(
  skills: SkillsParam
): Promise<string> {
  const { formatSkillsForPrompt } =
    (await import("@earendil-works/pi-coding-agent")) as {
      formatSkillsForPrompt: typeof FormatSkillsForPrompt;
    };
  return formatSkillsForPrompt(skills).replace(
    "Use the read tool to load a skill's file when the task matches its description.",
    "Use the skill tool to invoke a skill when the task matches its description. Treat the returned content as active instructions to follow, not text to summarize. Do not read SKILL.md directly."
  );
}

type PromptOptions = BeforeAgentStartEvent["systemPromptOptions"];

function collectGuidelines(options: PromptOptions): string[] {
  const guidelines = [
    ...options.selectedTools.flatMap(
      (name) => options.toolGuidelines[name] ?? []
    ),
    ...options.promptGuidelines,
  ].map((g) => g.trim());
  return [...new Set(guidelines.filter(Boolean))];
}

function renderSections(sections: PromptOptions["sections"]): string {
  return Object.entries(sections)
    .filter(([, content]) => content)
    .map(([name, content]) => `<${name}>\n${content}\n</${name}>`)
    .join("\n\n");
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    const base = buildSystemPrompt({
      model: ctx.model,
      cwd: options.cwd,
      contextFiles: options.contextFiles,
      skillsBlock:
        options.skills.length > 0
          ? await formatSkillsForAmpPrompt(options.skills)
          : "",
      toolGuidelines: collectGuidelines(options),
      appendSystemPrompt: options.appendSystemPrompt,
      customPrompt: options.customPrompt,
    });
    // Built-in extensions (e.g. MCP's `mcp_servers`) run after this handler
    // and add their prompt sections to the same options object, which a
    // forced prompt would otherwise drop. Resolve the forced text lazily so
    // it carries whatever sections exist when pi reads it; a later
    // `systemPrompt` override still wins through the setter.
    let override: string | undefined;
    Object.defineProperty(options, "forceSystemPrompt", {
      configurable: true,
      enumerable: true,
      get: () => {
        if (override !== undefined) {
          return override;
        }
        const extra = renderSections(options.sections);
        return extra ? `${base}\n\n${extra}` : base;
      },
      set: (value: string | undefined) => {
        override = value;
      },
    });
  });
}
