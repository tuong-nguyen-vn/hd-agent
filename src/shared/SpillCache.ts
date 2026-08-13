import { mkdirSync, openSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Paths } from "./Paths";

const SPILL_FILE_RE =
  /^[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/;

export class SpillCache {
  public static readonly TTL_MS = 7 * 24 * 60 * 60 * 1000;
  public static readonly SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  public static readonly MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

  private static installed = false;

  public static dir(): string {
    return join(Paths.pimHomeDir(), "cache");
  }

  public static async write(
    prefix: string,
    ext: string,
    data: string | Uint8Array
  ): Promise<string | null> {
    const dir = SpillCache.dir();
    const path = join(dir, `${prefix}-${Bun.randomUUIDv7()}.${ext}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Open a spill file for incremental writes (same naming/permissions as
   * write(), so the sweeper manages it). Caller owns closing the fd.
   */
  public static openSync(
    prefix: string,
    ext: string
  ): { readonly fd: number; readonly path: string } | null {
    const dir = SpillCache.dir();
    const path = join(dir, `${prefix}-${Bun.randomUUIDv7()}.${ext}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(path, "wx", 0o600);
      return { fd, path };
    } catch {
      return null;
    }
  }

  public static async cleanup(
    dir = SpillCache.dir(),
    now = Date.now(),
    maxTotalBytes = SpillCache.MAX_TOTAL_BYTES
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    const cutoff = now - SpillCache.TTL_MS;
    const survivors: { path: string; mtimeMs: number; size: number }[] = [];
    await Promise.all(
      entries.map(async (name) => {
        if (!SPILL_FILE_RE.test(name)) {
          return;
        }
        const path = join(dir, name);
        try {
          const metadata = await stat(path);
          if (!metadata.isFile()) {
            return;
          }
          if (metadata.mtimeMs < cutoff) {
            await unlink(path);
            return;
          }
          survivors.push({
            path,
            mtimeMs: metadata.mtimeMs,
            size: metadata.size,
          });
        } catch {}
      })
    );

    // Spills can be large (bash streams full command output to disk), so TTL
    // alone can let the cache grow to many GB within a week. Enforce a total
    // budget, evicting oldest-first.
    let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= maxTotalBytes) {
      return;
    }
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of survivors) {
      if (total <= maxTotalBytes) {
        break;
      }
      try {
        await unlink(entry.path);
        total -= entry.size;
      } catch {}
    }
  }

  /**
   * Idempotent: registers the full spill-file lifecycle (startup sweep,
   * periodic sweep, and cleanup on exit/termination) once, no matter how many
   * extensions call it. Each tool that writes spills calls this in its setup.
   */
  public static installSweeper(): void {
    if (SpillCache.installed) {
      return;
    }
    SpillCache.installed = true;

    void SpillCache.cleanup();
    setInterval(() => {
      void SpillCache.cleanup();
    }, SpillCache.SWEEP_INTERVAL_MS).unref?.();
    process.once("exit", () => {
      // "exit" handlers must be synchronous, so this best-effort sweep only
      // catches files already resolved by the time exit fires.
      void SpillCache.cleanup();
    });

    // Signal-induced termination skips the "exit" handler, so sweep here too.
    // Re-raise after our once-handler is gone so the default termination still
    // happens — merely registering a signal listener otherwise suppresses it.
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(sig, () => {
        SpillCache.cleanup()
          .catch(() => {})
          .finally(() => {
            process.kill(process.pid, sig);
          });
      });
    }
  }
}
