import type {
  SessionManager as SessionManagerType,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const CACHE_TTL_MS = 10_000;

type SessionLoader = (cwd: string) => Promise<SessionInfo[]>;

function ageLabel(date: Date, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 60) {
    return "now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return date.toISOString().slice(0, 10);
}

function compact(text: string, max = 72): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

function score(session: SessionInfo, query: string): number | undefined {
  if (!query) {
    return 0;
  }
  const needle = query.toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  const name = session.name?.toLowerCase() ?? "";
  const first = session.firstMessage.toLowerCase();
  const id = session.id.toLowerCase();
  const haystack = `${name}\n${first}\n${id}`;
  if (!terms.every((term) => haystack.includes(term))) {
    return undefined;
  }
  let total = 0;
  if (id === needle) {
    total += 1000;
  } else if (id.startsWith(needle)) {
    total += 500;
  }
  if (name === needle) {
    total += 400;
  } else if (name.includes(needle)) {
    total += 250;
  }
  if (first.includes(needle)) {
    total += 100;
  }
  for (const term of terms) {
    if (name.includes(term)) {
      total += 30;
    }
    if (first.includes(term)) {
      total += 10;
    }
  }
  return total;
}

export class SessionSuggestionEngine {
  private sessions: readonly SessionInfo[] = [];
  private loadedAt = 0;
  private loadPromise: Promise<void> | undefined;

  public constructor(
    private readonly cwd: string,
    private readonly sessionDir: string,
    private readonly currentSessionId: () => string,
    private readonly load: SessionLoader = async (workspace) => {
      const { SessionManager } =
        (await import("@earendil-works/pi-coding-agent")) as {
          SessionManager: typeof SessionManagerType;
        };
      return SessionManager.list(workspace, sessionDir);
    }
  ) {}

  public async rank(
    query: string,
    options: { readonly limit: number; readonly signal?: AbortSignal }
  ): Promise<readonly AutocompleteItem[]> {
    if (options.signal?.aborted) {
      return [];
    }
    await this.ensureLoaded();
    if (options.signal?.aborted) {
      return [];
    }

    const currentId = this.currentSessionId();
    return this.sessions
      .filter((session) => session.id !== currentId)
      .map((session) => ({ session, score: score(session, query.trim()) }))
      .filter(
        (
          item
        ): item is { readonly session: SessionInfo; readonly score: number } =>
          item.score !== undefined
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.session.modified.getTime() - a.session.modified.getTime()
      )
      .slice(0, options.limit)
      .map(({ session }) => ({
        value: `@@session:${session.id}`,
        label: compact(
          session.name || session.firstMessage || "Unnamed session"
        ),
        description: `${session.id.slice(0, 12)} · ${ageLabel(session.modified)} · ${session.messageCount} messages`,
      }));
  }

  public refresh(): void {
    this.loadedAt = 0;
    void this.ensureLoaded().catch(() => {});
  }

  private async ensureLoaded(): Promise<void> {
    if (Date.now() - this.loadedAt < CACHE_TTL_MS) {
      return;
    }
    this.loadPromise ??= this.load(this.cwd)
      .then((sessions) => {
        this.sessions = sessions;
        this.loadedAt = Date.now();
      })
      .finally(() => {
        this.loadPromise = undefined;
      });
    await this.loadPromise;
  }
}
