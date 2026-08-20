import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
let root: string;
let userAgentsDir: string;
let projectDir: string;

async function writeAgent(
  dir: string,
  fileName: string,
  content: string
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content, "utf-8");
}

describe("discoverAgents", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pim-subagent-"));
    userAgentsDir = join(root, "user-agent-dir", "agents");
    projectDir = join(root, "project");
    process.env["PI_CODING_AGENT_DIR"] = join(root, "user-agent-dir");
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("loads user agents with parsed frontmatter", async () => {
    await writeAgent(
      userAgentsDir,
      "reviewer.md",
      [
        "---",
        "name: reviewer",
        "description: Reviews code for bugs",
        "tools: read, grep",
        "model: anthropic/claude-haiku-4-5",
        "---",
        "You are a meticulous code reviewer.",
      ].join("\n")
    );

    const { discoverAgents } = await import("./agents");
    const agents = await discoverAgents(projectDir);

    const reviewerAgent = agents.find((a) => a.name === "reviewer");
    expect(reviewerAgent).toEqual({
      name: "reviewer",
      description: "Reviews code for bugs",
      tools: ["read", "grep"],
      model: "anthropic/claude-haiku-4-5",
      systemPrompt: "You are a meticulous code reviewer.",
      source: "user",
    });
  });

  test("ignores files missing required frontmatter", async () => {
    await writeAgent(
      userAgentsDir,
      "broken.md",
      ["---", "description: missing a name", "---", "body"].join("\n")
    );

    const { discoverAgents } = await import("./agents");
    const agents = await discoverAgents(projectDir);

    expect(agents.some((a) => a.name === "Search")).toBe(true);
    expect(agents.some((a) => a.name === "Oracle")).toBe(true);
    expect(agents.some((a) => a.name === "broken")).toBe(false);
  });

  test("project agents override user agents with the same name", async () => {
    await writeAgent(
      userAgentsDir,
      "helper.md",
      [
        "---",
        "name: helper",
        "description: user helper",
        "---",
        "user prompt",
      ].join("\n")
    );
    const nestedProjectDir = join(projectDir, "nested");
    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await mkdir(nestedProjectDir, { recursive: true });
    await writeAgent(
      join(projectDir, ".pi", "agents"),
      "helper.md",
      [
        "---",
        "name: helper",
        "description: project helper",
        "---",
        "project prompt",
      ].join("\n")
    );

    const { discoverAgents } = await import("./agents");
    // Discovery walks up from a nested cwd to find the nearest .pi/agents.
    const agents = await discoverAgents(nestedProjectDir);

    const helperAgent = agents.find((a) => a.name === "helper");
    expect(helperAgent).toEqual({
      name: "helper",
      description: "project helper",
      tools: undefined,
      model: undefined,
      systemPrompt: "project prompt",
      source: "project",
    });
  });

  test("bundles Search and Oracle agents by default", async () => {
    const { discoverAgents } = await import("./agents");
    const agents = await discoverAgents(projectDir);

    const agentNames = agents.map((a) => a.name);
    expect(agentNames).toContain("Search");
    expect(agentNames).toContain("Oracle");

    const searchAgent = agents.find((a) => a.name === "Search");
    expect(searchAgent?.source).toBe("bundled");
    expect(searchAgent?.tools).toEqual(["grep", "glob", "read"]);

    const oracleAgent = agents.find((a) => a.name === "Oracle");
    expect(oracleAgent?.source).toBe("bundled");
    expect(oracleAgent?.tools).toEqual([
      "grep",
      "glob",
      "read",
      "web_search",
      "web_fetch",
    ]);
  });

  test("user agents override bundled agents by case-insensitive name", async () => {
    await writeAgent(
      userAgentsDir,
      "search.md",
      [
        "---",
        "name: Search",
        "description: custom search",
        "tools: custom-tool",
        "---",
        "custom search prompt",
      ].join("\n")
    );

    const { discoverAgents } = await import("./agents");
    const agents = await discoverAgents(projectDir);

    const searchAgent = agents.find((a) => a.name === "Search");
    expect(searchAgent?.source).toBe("user");
    expect(searchAgent?.description).toBe("custom search");
    expect(searchAgent?.tools).toEqual(["custom-tool"]);
  });

  test("project agents override user and bundled agents by case-insensitive name", async () => {
    await writeAgent(
      userAgentsDir,
      "oracle.md",
      [
        "---",
        "name: Oracle",
        "description: user oracle",
        "---",
        "user oracle prompt",
      ].join("\n")
    );

    await mkdir(join(projectDir, ".pi", "agents"), { recursive: true });
    await writeAgent(
      join(projectDir, ".pi", "agents"),
      "oracle.md",
      [
        "---",
        "name: oracle",
        "description: project oracle",
        "---",
        "project oracle prompt",
      ].join("\n")
    );

    const { discoverAgents } = await import("./agents");
    const agents = await discoverAgents(projectDir);

    const oracleAgent = agents.find((a) => a.name === "oracle");
    expect(oracleAgent?.source).toBe("project");
    expect(oracleAgent?.description).toBe("project oracle");
  });
});
