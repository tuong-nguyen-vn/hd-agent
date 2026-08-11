import type {
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

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const {
      cwd,
      contextFiles,
      skills,
      promptGuidelines,
      appendSystemPrompt,
      customPrompt,
    } = event.systemPromptOptions;
    return {
      systemPrompt: buildSystemPrompt({
        model: ctx.model,
        cwd,
        contextFiles: contextFiles ?? [],
        skillsBlock:
          skills && skills.length > 0
            ? await formatSkillsForAmpPrompt(skills)
            : "",
        toolGuidelines: promptGuidelines ?? [],
        appendSystemPrompt,
        customPrompt,
      }),
    };
  });
}
