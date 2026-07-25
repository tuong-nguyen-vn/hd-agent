import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, describeOs } from "./prompt";

describe("buildSystemPrompt", () => {
  test("emits a best-effort os field instead of process.platform", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      contextFiles: [],
      skillsBlock: "",
      toolGuidelines: [],
      os: "Ubuntu 24.04.2 LTS",
    });

    expect(prompt).toContain("- os: Ubuntu 24.04.2 LTS");
    expect(prompt).not.toContain("- platform:");
  });

  test("includes the diagrams behavioral block between system_instructions and environment", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      contextFiles: [],
      skillsBlock: "",
      toolGuidelines: [],
    });

    expect(prompt).toContain("<diagrams>");
    expect(prompt).toContain("```diagram");
    expect(prompt).toContain("</diagrams>");

    const sysIdx = prompt.indexOf("</system_instructions>");
    const diaIdx = prompt.indexOf("<diagrams>");
    const envIdx = prompt.indexOf("<environment>");
    expect(sysIdx).toBeLessThan(diaIdx);
    expect(diaIdx).toBeLessThan(envIdx);
  });

  test("includes all behavioral blocks in a fixed order", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      contextFiles: [],
      skillsBlock: "",
      toolGuidelines: [],
    });

    const order = [
      "</system_instructions>",
      "<autonomy_and_persistence>",
      "<investigate_before_acting>",
      "<pragmatism_and_scope>",
      "<verification>",
      "<executing_actions_with_care>",
      "<tool_use>",
      "<output_efficiency>",
      "<diagrams>",
      "<environment>",
    ];

    let previous = -1;
    for (const marker of order) {
      const idx = prompt.indexOf(marker);
      expect(idx).toBeGreaterThan(previous);
      previous = idx;
    }
  });

  test("bakes URL, emoji, and tool-call tone rules into system_instructions", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      contextFiles: [],
      skillsBlock: "",
      toolGuidelines: [],
    });

    expect(prompt).toContain("NEVER generate or guess URLs");
    expect(prompt).toContain("Do not use emojis");
    expect(prompt).toContain("`file_path:line_number`");
    expect(prompt).toContain("Do not use a colon before tool calls");
  });

  test("still emits behavioral blocks when a customPrompt overrides system_instructions", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      contextFiles: [],
      skillsBlock: "",
      toolGuidelines: [],
      customPrompt: "custom identity here",
    });

    expect(prompt).toContain("custom identity here");
    expect(prompt).not.toContain("<system_instructions>");
    expect(prompt).toContain("<autonomy_and_persistence>");
    expect(prompt).toContain("<verification>");
    expect(prompt).toContain("<tool_use>");
    expect(prompt).toContain("<diagrams>");
  });
});

describe("describeOs", () => {
  test("uses PRETTY_NAME from /etc/os-release on Linux", () => {
    const os = describeOs({
      platform: "linux",
      runCommand: (cmd) =>
        cmd.join(" ") === "cat /etc/os-release"
          ? 'NAME="Ubuntu"\nVERSION="24.04.2 LTS"\nPRETTY_NAME="Ubuntu 24.04.2 LTS"\n'
          : undefined,
    });

    expect(os).toBe("Ubuntu 24.04.2 LTS");
  });

  test("formats macOS from sw_vers", () => {
    const os = describeOs({
      platform: "darwin",
      runCommand: (cmd) =>
        cmd.join(" ") === "sw_vers"
          ? "ProductName:\t\tmacOS\nProductVersion:\t15.5\nBuildVersion:\t\t24F74\n"
          : undefined,
    });

    expect(os).toBe("macOS 15.5");
  });

  test("falls back to process platform when no probe succeeds", () => {
    const os = describeOs({
      platform: "linux",
      runCommand: () => undefined,
    });

    expect(os).toBe("linux");
  });

  test("falls back to NAME and VERSION when PRETTY_NAME is absent", () => {
    const os = describeOs({
      platform: "linux",
      runCommand: (cmd) =>
        cmd.join(" ") === "cat /etc/os-release"
          ? 'NAME=Fedora\nVERSION="40 (Workstation Edition)"'
          : undefined,
    });

    expect(os).toBe("Fedora 40 (Workstation Edition)");
  });
});
