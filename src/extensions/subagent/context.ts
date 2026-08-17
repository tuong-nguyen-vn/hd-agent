import { isAbsolute, resolve } from "node:path";
import { FsErrors } from "../../shared/FsErrors";

// Budgets for inlined file content. Oversized calls are rejected before the
// subagent session is created, so the main agent gets immediate feedback to
// pass narrower line ranges instead of the subagent receiving a mangled
// prompt. Large enough for a handful of full source files, small enough to
// leave most of the subagent's context window for its own reasoning.
export const CONTEXT_BYTE_CAP = 150 * 1024;
export const PER_FILE_BYTE_CAP = 50 * 1024;

type ParsedContextPath = {
  readonly path: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
};

function parseContextPath(raw: string): ParsedContextPath {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/u.exec(raw.trim());
  if (!match) {
    return { path: raw.trim(), start: undefined, end: undefined };
  }
  const start = Number(match[2]);
  const end = match[3] !== undefined ? Number(match[3]) : start;
  return { path: match[1]!, start, end };
}

function formatKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)}KB`;
}

// Builds a "Provided context files" prompt section from context_paths
// entries. Throws before any subagent work starts on a missing file, an
// out-of-bounds range, or content exceeding PER_FILE_BYTE_CAP per entry or
// CONTEXT_BYTE_CAP in total, so the main agent can correct the call.
export async function buildContextBlock(
  contextPaths: readonly string[] | undefined,
  cwd: string,
  byteCap: number = CONTEXT_BYTE_CAP,
  perFileCap: number = PER_FILE_BYTE_CAP
): Promise<string> {
  if (!contextPaths || contextPaths.length === 0) {
    return "";
  }

  const sections: string[] = [];
  const oversize: string[] = [];
  let total = 0;

  for (const raw of contextPaths) {
    const { path, start, end } = parseContextPath(raw);
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);

    const stats = await FsErrors.statOrThrow(absolute);
    if (stats.isDirectory()) {
      throw new Error(
        `context_paths entry "${raw}" is a directory. Pass file paths, optionally with a line range ("path:start-end").`
      );
    }

    const content = await Bun.file(absolute).text();
    const allLines = content.split("\n");
    // Drop the artifact of a trailing newline so line counts match editors.
    if (allLines.at(-1) === "") {
      allLines.pop();
    }
    const from = Math.max(1, start ?? 1);
    const to = Math.min(allLines.length, end ?? allLines.length);
    if (from > to) {
      throw new Error(
        `context_paths range out of bounds: "${raw}" — the file has ${allLines.length} lines.`
      );
    }

    const numbered = allLines
      .slice(from - 1, to)
      .map((line, i) => `${from + i}: ${line}`)
      .join("\n");
    const bytes = Buffer.byteLength(numbered, "utf8");
    if (bytes > perFileCap) {
      oversize.push(
        `${raw} (${formatKb(bytes)} > ${formatKb(perFileCap)} per-file cap)`
      );
    }
    total += bytes;

    const heading =
      start !== undefined || from !== 1 || to !== allLines.length
        ? `${path} (lines ${from}-${to})`
        : path;
    sections.push("", `### ${heading}`, "", "```", numbered, "```");
  }

  if (oversize.length > 0 || total > byteCap) {
    const reasons = [...oversize];
    if (total > byteCap) {
      reasons.push(`total ${formatKb(total)} > ${formatKb(byteCap)} cap`);
    }
    throw new Error(
      `context_paths too large: ${reasons.join("; ")}. ` +
        'Pass narrower line ranges ("path:start-end") or drop files — ' +
        "nothing was sent to the subagent."
    );
  }

  return [
    "## Provided context files",
    "",
    "The following file contents were read when this task was delegated. " +
      "Treat them as the primary source: cite them as path:line, and re-read " +
      "a file only if you need lines outside the provided ranges.",
    ...sections,
  ].join("\n");
}
