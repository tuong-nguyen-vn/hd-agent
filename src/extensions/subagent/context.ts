import { isAbsolute, relative, resolve } from "node:path";
import { FsErrors } from "../../shared/FsErrors";

// Budgets for inlined file content. Oversized context_paths calls are
// rejected before the subagent session is created, so the main agent gets
// immediate feedback to pass narrower line ranges instead of the subagent
// receiving a mangled prompt. Large enough for a review brief's worth of
// source, small enough to leave most of the subagent's context window for
// its own reasoning.
export const CONTEXT_BYTE_CAP = 256 * 1024;
export const PER_FILE_BYTE_CAP = 64 * 1024;

// Leading bytes scanned for a NUL to tell binary files from text.
const BINARY_SNIFF_BYTES = 8192;

// A cited file at or under this many lines is inlined whole: the full body
// of a small file costs little and spares the subagent a re-read for lines
// just outside the range it was pointed at.
export const WHOLE_FILE_LINE_LIMIT = 400;

// Lines kept on either side of a cited range in a larger file, so the
// subagent sees the enclosing function rather than the quoted fragment.
export const CITATION_CONTEXT_LINES = 40;

// Briefs cite source as `path`, `path:line`, or `path:start-end`, usually
// with a shortened path ("kernel/runtime/pipeline.py" for a file that
// actually lives under src/). Requiring a file extension keeps prose like
// "12:30", "Python 3.12", or a bare package name from registering.
const CITATION_PATTERN =
  /(?:^|[^\w./-])([\w.\-/]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?:-(\d+))?)?/gu;

type ParsedContextPath = {
  readonly path: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
};

type LineRange = {
  readonly start: number;
  readonly end: number;
};

type Section = {
  readonly text: string;
  readonly bytes: number;
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

// Returns undefined for a file that is not text. Decoding an image or an
// archive yields replacement characters rather than an error, so without
// this a cited asset would be inlined as pages of mojibake.
async function readLines(absolute: string): Promise<string[] | undefined> {
  const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer());
  const sniff = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniff; i += 1) {
    if (bytes[i] === 0) {
      return undefined;
    }
  }
  const lines = new TextDecoder().decode(bytes).split("\n");
  // Drop the artifact of a trailing newline so line counts match editors.
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function numberLines(
  lines: readonly string[],
  from: number,
  to: number
): string {
  return lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}: ${line}`)
    .join("\n");
}

function makeSection(
  display: string,
  numbered: string,
  range: LineRange | undefined
): Section {
  const heading = range
    ? `${display} (lines ${range.start}-${range.end})`
    : display;
  const text = ["", `### ${heading}`, "", "```", numbered, "```"].join("\n");
  return { text, bytes: Buffer.byteLength(numbered, "utf8") };
}

// Merges overlapping or touching ranges so a file cited at several nearby
// lines yields one window instead of repeating the same lines per citation.
function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, range.end),
      };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

async function explicitSections(
  contextPaths: readonly string[],
  cwd: string,
  perFileCap: number
): Promise<{
  readonly sections: readonly Section[];
  readonly total: number;
  readonly absolutes: ReadonlySet<string>;
  readonly oversize: readonly string[];
}> {
  const sections: Section[] = [];
  const absolutes = new Set<string>();
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

    const lines = await readLines(absolute);
    if (!lines) {
      throw new Error(
        `context_paths entry "${raw}" is not a text file. Pass source files the subagent can read.`
      );
    }
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? lines.length);
    if (from > to) {
      throw new Error(
        `context_paths range out of bounds: "${raw}" — the file has ${lines.length} lines.`
      );
    }

    const section = makeSection(
      path,
      numberLines(lines, from, to),
      start !== undefined || from !== 1 || to !== lines.length
        ? { start: from, end: to }
        : undefined
    );
    if (section.bytes > perFileCap) {
      oversize.push(
        `${raw} (${formatKb(section.bytes)} > ${formatKb(perFileCap)} per-file cap)`
      );
    }
    total += section.bytes;
    absolutes.add(absolute);
    sections.push(section);
  }

  return { sections, total, absolutes, oversize };
}

// Every tracked and untracked-but-not-ignored file in the repo, used to
// resolve the shortened paths briefs cite. Returns an empty list outside a
// git checkout, which disables citation resolution rather than failing.
async function repoFiles(cwd: string): Promise<readonly string[]> {
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, stdout: "pipe", stderr: "ignore" }
    );
    const [out] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (proc.exitCode !== 0) {
      return [];
    }
    return out.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

// Resolves a cited path directly when it is already repo-relative, and
// otherwise by unique path suffix — briefs routinely write
// "kernel/runtime/pipeline.py" for src/pkg/kernel/runtime/pipeline.py.
// An ambiguous suffix resolves to nothing: attaching the wrong file is
// worse than letting the subagent read the right one itself.
async function resolveCitedPath(
  path: string,
  cwd: string,
  index: readonly string[]
): Promise<string | undefined> {
  const direct = isAbsolute(path) ? path : resolve(cwd, path);
  const stats = await Bun.file(direct)
    .stat()
    .catch(() => undefined);
  if (stats?.isFile()) {
    return direct;
  }
  if (isAbsolute(path)) {
    return undefined;
  }

  const suffix = `/${path}`;
  const matches = index.filter(
    (entry) => entry === path || entry.endsWith(suffix)
  );
  return matches.length === 1 ? resolve(cwd, matches[0]!) : undefined;
}

// Maps each cited path to the ranges it was cited at. A path named without
// a line number maps to an empty list, meaning "inline the whole file".
// Line-cited paths come first: they are the stronger signal, so they claim
// the budget before bare mentions do.
// Headings name the resolved file, not the shortened path the brief used,
// so the subagent cites something that actually exists on disk.
function displayPath(absolute: string, cwd: string): string {
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith("..") ? rel : absolute;
}

function collectCitations(prompt: string): Map<string, LineRange[]> {
  const cited = new Map<string, LineRange[]>();
  for (const match of prompt.matchAll(CITATION_PATTERN)) {
    const path = match[1]!;
    const ranges = cited.get(path) ?? [];
    if (match[2] !== undefined) {
      const start = Number(match[2]);
      const end = match[3] !== undefined ? Number(match[3]) : start;
      if (start >= 1 && end >= start) {
        ranges.push({ start, end });
      }
    }
    cited.set(path, ranges);
  }
  return new Map(
    [...cited].sort(
      ([, a], [, b]) => (b.length > 0 ? 1 : 0) - (a.length > 0 ? 1 : 0)
    )
  );
}

export type CitedContext = {
  readonly sections: readonly Section[];
  readonly total: number;
  readonly skipped: readonly string[];
};

// Inlines the files a brief cites but never passed via context_paths. This
// is best-effort: anything that cannot be resolved, is too large, or no
// longer fits the budget is skipped and named, so the subagent knows to
// read it itself instead of silently reasoning without it.
export async function collectCitedSections(
  prompt: string,
  cwd: string,
  exclude: ReadonlySet<string>,
  budget: number,
  perFileCap: number = PER_FILE_BYTE_CAP
): Promise<CitedContext> {
  const cited = collectCitations(prompt);
  if (cited.size === 0 || budget <= 0) {
    return { sections: [], total: 0, skipped: [] };
  }

  const index = await repoFiles(cwd);
  const sections: Section[] = [];
  const skipped: string[] = [];
  const seen = new Set(exclude);
  let total = 0;

  for (const [path, ranges] of cited) {
    const absolute = await resolveCitedPath(path, cwd, index);
    if (!absolute || seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);

    const lines = await readLines(absolute).catch(() => undefined);
    if (!lines || lines.length === 0) {
      continue;
    }

    const windows =
      ranges.length === 0 || lines.length <= WHOLE_FILE_LINE_LIMIT
        ? [{ start: 1, end: lines.length }]
        : mergeRanges(
            ranges.map((range) => ({
              start: Math.max(1, range.start - CITATION_CONTEXT_LINES),
              end: Math.min(lines.length, range.end + CITATION_CONTEXT_LINES),
            }))
          );

    const whole =
      windows.length === 1 &&
      windows[0]!.start === 1 &&
      windows[0]!.end === lines.length;
    const display = displayPath(absolute, cwd);
    const fileSections = windows.map((window) =>
      makeSection(
        display,
        numberLines(lines, window.start, window.end),
        whole ? undefined : window
      )
    );
    const bytes = fileSections.reduce((sum, s) => sum + s.bytes, 0);

    if (bytes > perFileCap || total + bytes > budget) {
      skipped.push(display);
      continue;
    }
    total += bytes;
    sections.push(...fileSections);
  }

  return { sections, total, skipped };
}

function renderBlock(
  sections: readonly Section[],
  skipped: readonly string[]
): string {
  if (sections.length === 0 && skipped.length === 0) {
    return "";
  }
  const notes =
    skipped.length > 0
      ? [
          "",
          `Not inlined (too large or over budget) — read these yourself if you need them: ${skipped.join(", ")}.`,
        ]
      : [];
  return [
    "## Provided context files",
    "",
    "The following file contents were read when this task was delegated — " +
      "both the files passed explicitly and the ones this brief cites by " +
      "path:line. Treat them as the primary source: cite them as path:line, " +
      "and re-read a file only if you need lines outside the provided ranges.",
    ...notes,
    ...sections.map((section) => section.text),
  ].join("\n");
}

// Assembles the full subagent prompt: the task, then one context block
// holding the explicitly passed files plus every file the task cites as
// path:line. Explicit files are budgeted first and still reject the call
// when oversized; cited files only fill what budget is left over.
export async function buildSubagentPrompt(
  prompt: string,
  contextPaths: readonly string[] | undefined,
  cwd: string,
  byteCap: number = CONTEXT_BYTE_CAP,
  perFileCap: number = PER_FILE_BYTE_CAP
): Promise<string> {
  const explicit =
    contextPaths && contextPaths.length > 0
      ? await explicitSections(contextPaths, cwd, perFileCap)
      : undefined;

  if (explicit && (explicit.oversize.length > 0 || explicit.total > byteCap)) {
    const reasons = [...explicit.oversize];
    if (explicit.total > byteCap) {
      reasons.push(
        `total ${formatKb(explicit.total)} > ${formatKb(byteCap)} cap`
      );
    }
    throw new Error(
      `context_paths too large: ${reasons.join("; ")}. ` +
        'Pass narrower line ranges ("path:start-end") or drop files — ' +
        "nothing was sent to the subagent."
    );
  }

  const cited = await collectCitedSections(
    prompt,
    cwd,
    explicit?.absolutes ?? new Set(),
    byteCap - (explicit?.total ?? 0),
    perFileCap
  );

  const block = renderBlock(
    [...(explicit?.sections ?? []), ...cited.sections],
    cited.skipped
  );
  return block ? `${prompt}\n\n${block}` : prompt;
}
