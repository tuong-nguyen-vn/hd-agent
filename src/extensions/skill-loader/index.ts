import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Levenshtein } from "../../shared/Levenshtein";
import {
  Renderer,
  type StatefulToolCallTitleContext,
  type StatefulToolCallTitleState,
} from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";

const skillSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    description:
      'Skill name from <available_skills>, such as "agent-browser" or "tldraw-offline".',
  }),
});

type SkillInput = Static<typeof skillSchema>;

type SkillDetails = {
  skillName: string;
  filePath: string;
  alreadyLoaded?: boolean;
  isError?: boolean;
};

type SkillCallState = StatefulToolCallTitleState & {
  skillName?: string;
  filePath?: string;
};

type SkillRenderContext = StatefulToolCallTitleContext & {
  readonly args?: Partial<SkillInput>;
};

export type SkillEntry = {
  name: string;
  description: string;
  filePath: string;
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseSkillEntries(systemPrompt: string): SkillEntry[] {
  const block = systemPrompt.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/
  )?.[1];
  if (!block) {
    return [];
  }

  const entries: SkillEntry[] = [];
  const skillRe = /<skill>([\s\S]*?)<\/skill>/g;
  let skillMatch: RegExpExecArray | null;
  while ((skillMatch = skillRe.exec(block)) !== null) {
    const body = skillMatch[1]!;
    const name = body.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim();
    const description = body
      .match(/<description>([\s\S]*?)<\/description>/)?.[1]
      ?.trim();
    const filePath = body
      .match(/<location>([\s\S]*?)<\/location>/)?.[1]
      ?.trim();
    if (name && description !== undefined && filePath) {
      entries.push({
        name: decodeXml(name),
        description: decodeXml(description),
        filePath: decodeXml(filePath),
      });
    }
  }
  return entries;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findSkill(
  query: string,
  entries: readonly SkillEntry[]
): SkillEntry | undefined {
  const normalized = normalize(query);
  if (!normalized) {
    return undefined;
  }

  const exact = entries.find(
    (entry) => entry.name.toLowerCase() === query.toLowerCase()
  );
  if (exact) {
    return exact;
  }

  const equivalent = entries.find(
    (entry) => normalize(entry.name) === normalized
  );
  if (equivalent) {
    return equivalent;
  }

  const partial = entries.filter((entry) => {
    const name = normalize(entry.name);
    return name.includes(normalized) || normalized.includes(name);
  });
  if (partial.length === 1) {
    return partial[0];
  }

  let closest: { entry: SkillEntry; distance: number } | undefined;
  for (const entry of entries) {
    const name = normalize(entry.name);
    const distance = Levenshtein.distance(normalized, name);
    const threshold = Math.max(2, Math.floor(name.length / 4));
    if (distance <= threshold && (!closest || distance < closest.distance)) {
      closest = { entry, distance };
    }
  }
  return closest?.entry;
}

function suggestionsFor(
  query: string,
  entries: readonly SkillEntry[]
): SkillEntry[] {
  const normalized = normalize(query);
  return [...entries]
    .map((entry) => ({
      entry,
      distance: Levenshtein.distance(normalized, normalize(entry.name)),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ entry }) => entry);
}

// Extension modules are shared by parent and subagent sessions. Keying by the
// session manager object keeps loaded state isolated while allowing GC after a
// short-lived subagent session is released.
const loadedBySession = new WeakMap<object, Set<string>>();

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function collectClaudeSkillDirs(
  cwd: string,
  home: string,
  projectTrusted: boolean
): string[] {
  const globalDir = resolve(home, ".claude", "skills");
  const result: string[] = [];

  if (projectTrusted) {
    const root = findGitRoot(cwd);
    let dir = resolve(cwd);
    while (true) {
      const candidate = resolve(dir, ".claude", "skills");
      if (candidate !== globalDir && isDirectory(candidate)) {
        result.push(candidate);
      }
      if ((root && dir === root) || dirname(dir) === dir) {
        break;
      }
      dir = dirname(dir);
    }
  }

  if (isDirectory(globalDir)) {
    result.push(globalDir);
  }
  return result;
}

function loadedSkillsFor(sessionManager: object): Set<string> {
  let loaded = loadedBySession.get(sessionManager);
  if (!loaded) {
    loaded = new Set<string>();
    loadedBySession.set(sessionManager, loaded);
  }
  return loaded;
}

export function transformSkillCommand(text: string): string | undefined {
  if (!text.startsWith("/skill:")) {
    return undefined;
  }
  // Prefix with a space so pi core's _expandSkillCommand (which checks
  // startsWith("/skill:")) does not intercept and inline-expand the skill,
  // letting the model invoke the skill tool via system-prompt guidance.
  return ` ${text}`;
}

function renderSkillCall(
  input: Partial<SkillInput>,
  theme: Theme,
  context: SkillRenderContext
) {
  const state = context.state as SkillCallState;
  const skillName = state.skillName ?? input.name ?? "?";
  const title =
    state.filePath && state.filePath !== ""
      ? Renderer.renderFileLink(
          theme,
          skillName,
          dirname(state.filePath)
        )
      : theme.fg("accent", skillName);
  return Renderer.renderStatefulToolCallTitle({
    label: "Invoked skill",
    title,
    theme,
    context,
    labelColor: "muted",
    markerGlyph: Renderer.markerGlyphFor(
      Renderer.markerColorFor(
        Boolean(context.isPartial),
        Boolean(context.isError)
      )
    ),
    separator: " ",
    pad: false,
    useSpinner: true,
  });
}

export default function (pi: ExtensionAPI): void {
  pi.on("resources_discover", (event, ctx) => ({
    skillPaths: collectClaudeSkillDirs(
      event.cwd,
      homedir(),
      ctx.isProjectTrusted()
    ),
  }));

  const clearSessionCache = (_event: unknown, ctx: { sessionManager: object }) => {
    loadedBySession.delete(ctx.sessionManager);
  };
  pi.on("session_compact", clearSessionCache);
  pi.on("session_tree", clearSessionCache);
  pi.on("input", (event) => {
    const transformed = transformSkillCommand(event.text);
    return transformed
      ? { action: "transform" as const, text: transformed }
      : { action: "continue" as const };
  });

  Tools.register(pi, {
    name: "skill",
    label: "skill",
    description:
      "Invoke and activate an installed skill by name. Use this tool whenever a user asks to load/use a skill or when their task matches a skill in <available_skills>. " +
      "The result contains instructions to follow, not content to summarize. Do not use read on SKILL.md directly.",
    promptSnippet: "Invoke an installed skill",
    promptGuidelines: [
      "When a task matches an entry in <available_skills>, call the skill tool before acting.",
      "Treat skill tool output as active instructions: follow it and do not summarize it unless the user explicitly asks for a summary.",
      "Do not read SKILL.md directly; use the skill tool so invocation is tracked and rendered consistently.",
    ],
    parameters: skillSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("Skill invocation aborted before execution.");
      }

      const requestedName = (params as SkillInput).name.trim();
      const entries = parseSkillEntries(ctx.getSystemPrompt());
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No installed skills are visible in <available_skills>.",
            },
          ],
          details: {
            skillName: requestedName,
            filePath: "",
            isError: true,
          } satisfies SkillDetails,
        };
      }

      const skill = findSkill(requestedName, entries);
      if (!skill) {
        const suggestions = suggestionsFor(requestedName, entries);
        const lines = suggestions.map(
          (entry) => `- ${entry.name} — ${entry.description}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Skill "${requestedName}" was not found.`,
                suggestions.length > 0 ? "Did you mean:" : "",
                ...lines,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: {
            skillName: requestedName,
            filePath: "",
            isError: true,
          } satisfies SkillDetails,
        };
      }

      const loaded = loadedSkillsFor(ctx.sessionManager);
      if (loaded.has(skill.filePath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Skill "${skill.name}" is already active in this session. Continue following its instructions without invoking it again.`,
            },
          ],
          details: {
            skillName: skill.name,
            filePath: skill.filePath,
            alreadyLoaded: true,
          } satisfies SkillDetails,
        };
      }

      try {
        const rawContent = readFileSync(skill.filePath, "utf-8");
        const body = stripFrontmatter(rawContent).trim();
        loaded.add(skill.filePath);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Skill "${skill.name}" invoked. Follow these instructions for the current task; do not summarize them.`,
                `References are relative to ${dirname(skill.filePath)}.`,
                "",
                body,
              ].join("\n"),
            },
          ],
          details: {
            skillName: skill.name,
            filePath: skill.filePath,
          } satisfies SkillDetails,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to invoke skill "${skill.name}": ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {
            skillName: skill.name,
            filePath: skill.filePath,
            isError: true,
          } satisfies SkillDetails,
        };
      }
    },
    renderCall(args, theme, context) {
      return renderSkillCall(
        (args ?? {}) as Partial<SkillInput>,
        theme,
        context as SkillRenderContext
      );
    },
    renderResult(result, options, theme, context) {
      const state = context.state as SkillCallState;
      const details = result.details as SkillDetails | undefined;
      if (details?.skillName) {
        state.skillName = details.skillName;
      }
      if (details?.filePath !== undefined) {
        state.filePath = details.filePath;
      }
      renderSkillCall(
        (context.args ?? {}) as Partial<SkillInput>,
        theme,
        context as SkillRenderContext
      );
      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: 5,
      });
    },
  });
}
