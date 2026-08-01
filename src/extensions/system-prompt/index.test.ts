import { describe, expect, test } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForAmpPrompt } from "./index";

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
  test("directs the model to invoke the skill tool instead of reading SKILL.md", () => {
    const prompt = formatSkillsForAmpPrompt([skill]);

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
