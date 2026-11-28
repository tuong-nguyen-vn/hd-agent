import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function statePath(): string {
  return (
    process.env["HD_MEMORY_STATE_PATH"] ??
    join(homedir(), ".hd", "memory", "state.json")
  );
}

export function isMemoryEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as {
      enabled?: boolean;
    };
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

export function setMemoryEnabled(enabled: boolean): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled }, null, 2));
}
