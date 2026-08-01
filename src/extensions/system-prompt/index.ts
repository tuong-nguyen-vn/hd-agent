import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "./prompt";

export function formatSkillsForAmpPrompt(
  skills: Parameters<typeof formatSkillsForPrompt>[0]
): string {
  return formatSkillsForPrompt(skills).replace(
    "Use the read tool to load a skill's file when the task matches its description.",
    "Use the skill tool to invoke a skill when the task matches its description. Treat the returned content as active instructions to follow, not text to summarize. Do not read SKILL.md directly."
  );
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
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
          skills && skills.length > 0 ? formatSkillsForAmpPrompt(skills) : "",
        toolGuidelines: promptGuidelines ?? [],
        appendSystemPrompt,
        customPrompt,
      }),
    };
  });
}
