import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

const INDEX_DIR = join(homedir(), ".hd", "memory");
const DB_PATH = join(INDEX_DIR, "index.db");

export type JournalSearchResult = {
  readonly text: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly sessionFile: string;
};

type FileState = {
  readonly byteOffset: number;
  readonly mtimeMs: number;
  readonly size: number;
};

function defaultSessionsRoot(): string {
  return (
    process.env["HD_MEMORY_SESSIONS_ROOT"] ??
    join(homedir(), ".pi", "agent", "sessions")
  );
}

function defaultDbPath(): string {
  return process.env["HD_MEMORY_INDEX_DB"] ?? DB_PATH;
}

function openDatabase(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prompts (
      entry_id TEXT PRIMARY KEY,
      session_file TEXT NOT NULL,
      cwd TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
      text,
      content='prompts',
      content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON prompts BEGIN
      INSERT INTO prompts_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  return db;
}

export class JournalIndexer {
  private readonly db: Database;
  private readonly sessionsRoot: string;

  public constructor(
    dbPath: string = defaultDbPath(),
    sessionsRoot: string = defaultSessionsRoot()
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.sessionsRoot = sessionsRoot;
  }

  public search(
    query: string,
    limit = 10,
    preferCwd?: string
  ): JournalSearchResult[] {
    // Current-project prompts rank above cross-project hits: memory is
    // global for recall breadth, but the local project is usually the
    // context the user means.
    const rows = this.db
      .query(
        `SELECT p.text, p.timestamp, p.cwd, p.session_file
         FROM prompts_fts f JOIN prompts p ON p.rowid = f.rowid
         WHERE prompts_fts MATCH ?
         ORDER BY (p.cwd = ?) DESC, p.timestamp DESC
         LIMIT ?`
      )
      .all(query, preferCwd ?? "", limit) as Array<{
      text: string;
      timestamp: string;
      cwd: string;
      session_file: string;
    }>;
    return rows.map((r) => ({
      text: r.text,
      timestamp: r.timestamp,
      cwd: r.cwd,
      sessionFile: r.session_file,
    }));
  }

  public recent(limit = 200, since?: string): JournalSearchResult[] {
    const rows = since
      ? (this.db
          .query(
            `SELECT text, timestamp, cwd, session_file FROM prompts
             WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`
          )
          .all(since, limit) as Array<{
          text: string;
          timestamp: string;
          cwd: string;
          session_file: string;
        }>)
      : (this.db
          .query(
            `SELECT text, timestamp, cwd, session_file FROM prompts
             ORDER BY timestamp DESC LIMIT ?`
          )
          .all(limit) as Array<{
          text: string;
          timestamp: string;
          cwd: string;
          session_file: string;
        }>);
    return rows.map((r) => ({
      text: r.text,
      timestamp: r.timestamp,
      cwd: r.cwd,
      sessionFile: r.session_file,
    }));
  }

  public async indexSessions(): Promise<{ indexed: number }> {
    const files = listSessionFiles(this.sessionsRoot);
    let indexed = 0;
    for (const file of files) {
      indexed += this.indexFile(file);
    }
    return { indexed };
  }

  private fileState(path: string): FileState | undefined {
    const row = this.db
      .query(
        "SELECT byte_offset AS byteOffset, mtime_ms AS mtimeMs, size FROM files WHERE path = ?"
      )
      .get(path) as FileState | undefined;
    return row;
  }

  private indexFile(path: string): number {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return 0;
    }
    const state = this.fileState(path);
    if (state && state.size === stat.size) {
      return 0;
    }
    // Files are append-only; a size shrink means rotation, so restart. mtime
    // alone cannot gate freshness — fast consecutive writes can share one
    // timestamp tick.
    const offset = state && stat.size >= state.size ? state.byteOffset : 0;
    const result = readNewEntries(path, offset);
    let count = 0;
    const insert = this.db.query(
      `INSERT OR IGNORE INTO prompts (entry_id, session_file, cwd, timestamp, text)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const entry of result.prompts) {
      const changes = insert.run(
        entry.id,
        path,
        result.cwd,
        entry.timestamp,
        entry.text
      );
      if (changes.changes > 0) {
        count += 1;
      }
    }
    this.db
      .query(
        `INSERT OR REPLACE INTO files (path, byte_offset, mtime_ms, size)
         VALUES (?, ?, ?, ?)`
      )
      .run(path, result.nextOffset, stat.mtimeMs, stat.size);
    return count;
  }

  public close(): void {
    this.db.close();
  }
}

function listSessionFiles(root: string): string[] {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    const dirPath = join(root, dir);
    try {
      if (!statSync(dirPath).isDirectory()) {
        continue;
      }
      for (const name of readdirSync(dirPath)) {
        if (name.endsWith(".jsonl")) {
          files.push(join(dirPath, name));
        }
      }
    } catch {
      continue;
    }
  }
  return files;
}

type RawPrompt = {
  readonly id: string;
  readonly timestamp: string;
  readonly text: string;
};

function extractPrompt(entry: unknown): RawPrompt | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const e = entry as Record<string, unknown>;
  if (e["type"] !== "message") {
    return undefined;
  }
  const message = e["message"] as Record<string, unknown> | undefined;
  if (!message || message["role"] !== "user") {
    return undefined;
  }
  const content = message["content"];
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "text" &&
        typeof (b as { text?: string }).text === "string"
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    return undefined;
  }
  return {
    id: String(e["id"] ?? ""),
    timestamp: String(e["timestamp"] ?? ""),
    text,
  };
}

function readNewEntries(
  path: string,
  offset: number
): { prompts: RawPrompt[]; cwd: string; nextOffset: number } {
  // The indexer runs off the critical path in a fire-and-forget pass, so
  // synchronous reads keep it simple without hurting the session.
  let text: string;
  try {
    // Buffer slicing keeps offsets byte-accurate; string slicing would
    // count characters and corrupt multi-byte UTF-8 positions.
    text = readFileSync(path).subarray(offset).toString("utf8");
  } catch {
    return { prompts: [], cwd: "", nextOffset: offset };
  }
  const prompts: RawPrompt[] = [];
  let cwd = "";
  let consumed = 0;
  const lines = text.split("\n");
  // A trailing newline leaves an empty final element that carries no byte
  // of its own; counting its phantom separator would push the stored
  // offset one past the real end and corrupt tail reads.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const hasSeparator = i < lines.length - 1;
    // byteLength, not length: Vietnamese prompts are multi-byte UTF-8 and
    // the stored offset is measured in file bytes.
    const lineBytes = Buffer.byteLength(line) + (hasSeparator ? 1 : 0);
    if (!line.trim()) {
      consumed += lineBytes;
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // Partial trailing line from a concurrent writer: stop before it.
      break;
    }
    consumed += lineBytes;
    const e = entry as Record<string, unknown>;
    if (e["type"] === "session" && typeof e["cwd"] === "string") {
      cwd = e["cwd"];
      continue;
    }
    const prompt = extractPrompt(entry);
    if (prompt?.id) {
      prompts.push(prompt);
    }
  }
  return { prompts, cwd, nextOffset: offset + consumed };
}

export function journalIndexDir(): string {
  return INDEX_DIR;
}
