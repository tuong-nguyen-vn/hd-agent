import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Parse skill names from the system prompt's `<available_skills>` block.
 * The block is always present (built during session init, before any prompt)
 * and contains `<name>...</name>` entries for each visible skill.
 *
 * Returns an empty array if no skills are found.
 */
export function parseSkillNames(systemPrompt: string): string[] {
  const blockMatch = systemPrompt.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/
  );
  if (!blockMatch) {
    return [];
  }
  const names: string[] = [];
  const re = /<name>([^<]+)<\/name>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blockMatch[1]!)) !== null) {
    names.push(m[1]!.trim());
  }
  return names;
}

/**
 * Normalize a skill name or query by lowercasing and removing spaces/hyphens.
 * "agent-browser" → "agentbrowser", "agent browser" → "agentbrowser"
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s-]+/g, "");
}

/**
 * Try to match a natural language skill request and transform it into
 * a `/skill:name` command that the host's _expandSkillCommand will process.
 *
 * Returns the transformed text, or null if no skill match was found.
 */
export function trySkillTransform(
  text: string,
  skillNames: string[]
): string | null {
  const trimmed = text.trim();

  // Don't interfere with existing slash commands
  if (trimmed.startsWith("/")) {
    return null;
  }

  // Match: "[verb] skill <name>" — verb is optional
  // Supports EN: load, use, read, activate, start, run
  // Supports VN: dùng, đọc, chạy, hãy dùng, hãy đọc
  const match = trimmed.match(
    /(?:\b(?:load|use|dùng|dung|đọc|doc|hãy dùng|hay dung|hãy đọc|hay doc|activate|chạy|chay|start|run|read)\b\s+)?skill\s+(.+?)$/i
  );
  if (!match) {
    return null;
  }

  const rawName = match[1]!.trim();
  const normalized = normalize(rawName);

  // Try exact match, then normalized, then partial
  let matched: string | undefined;
  for (const name of skillNames) {
    if (name.toLowerCase() === rawName.toLowerCase()) {
      matched = name;
      break;
    }
  }
  if (!matched) {
    for (const name of skillNames) {
      if (normalize(name) === normalized) {
        matched = name;
        break;
      }
    }
  }
  if (!matched) {
    for (const name of skillNames) {
      const nn = normalize(name);
      if (nn.includes(normalized) || normalized.includes(nn)) {
        matched = name;
        break;
      }
    }
  }

  if (!matched) {
    return null;
  }

  return `/skill:${matched}`;
}

export default function (pi: ExtensionAPI): void {
  // Intercept natural language skill requests and transform to /skill: command.
  // Skills are parsed from ctx.getSystemPrompt() which is built during session
  // init (before any prompt), so they're always available.
  pi.on("input", (event, ctx) => {
    const systemPrompt = ctx.getSystemPrompt();
    if (!systemPrompt.includes("<available_skills>")) {
      return { action: "continue" as const };
    }

    const skillNames = parseSkillNames(systemPrompt);
    if (skillNames.length === 0) {
      return { action: "continue" as const };
    }

    const transformed = trySkillTransform(event.text, skillNames);
    if (transformed && transformed !== event.text) {
      return { action: "transform" as const, text: transformed };
    }

    return { action: "continue" as const };
  });
}
