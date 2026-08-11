import { join } from "node:path";
import { Fs } from "./Fs";

const MAX_ENTRIES = 200;

// Deferred to first call so pi-coding-agent is not imported at module load
// time (it triggers loading a second copy from hd-agent's own node_modules).
// By the time PromptHistory.path() is called (inside session_start), the
// module is already loaded by pi's own loader and cached in Bun's registry.
let cachedAgentDir: string | undefined;
async function getAgentDir(): Promise<string> {
  if (cachedAgentDir) {
    return cachedAgentDir;
  }
  const mod = (await import("@earendil-works/pi-coding-agent")) as {
    getAgentDir: () => string;
  };
  cachedAgentDir = mod.getAgentDir();
  return cachedAgentDir;
}

export class PromptHistory {
  public static async path(): Promise<string> {
    return join(await getAgentDir(), "prompt-history.json");
  }

  public static async load(): Promise<string[]> {
    return Fs.readJsonOrEmpty<string[]>(await PromptHistory.path(), []);
  }

  private static writeQueue: Promise<unknown> = Promise.resolve();

  /** Persist the editor's newest-first history array (overwrites the file). */
  public static persist(entriesNewestFirst: readonly string[]): void {
    // Stored oldest -> newest on disk so the file reads naturally and replays
    // in the same order addToHistory() was originally called.
    const oldestFirst = [...entriesNewestFirst].reverse().slice(-MAX_ENTRIES);
    PromptHistory.writeQueue = PromptHistory.writeQueue.then(async () =>
      Fs.writeAtomic(await PromptHistory.path(), JSON.stringify(oldestFirst))
    );
  }
}
