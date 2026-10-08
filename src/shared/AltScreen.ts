import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type AltScreenConstructor = Function & { readonly prototype: object };

// The reachable pi-tui copies are fixed for the process lifetime (a /reload
// re-imports this module, resetting the cache); resolve once instead of
// re-walking the filesystem on every session_start.
let constructorsPromise: Promise<AltScreenConstructor[]> | undefined;

export class AltScreen {
  /**
   * HD Agent can end up with two `pi-tui` copies: one hoisted next to the
   * extension and one nested in the installed package tree. Patching only the
   * imported copy leaves the running UI on the other class, so a prototype
   * patch silently never engages. Resolve every reachable `TuiAltScreen` from
   * the CLI entry.
   */
  public static constructors(): Promise<AltScreenConstructor[]> {
    constructorsPromise ??= resolveConstructors();
    return constructorsPromise;
  }
}

async function resolveConstructors(): Promise<AltScreenConstructor[]> {
  const constructors = new Set<AltScreenConstructor>();

  const entries = new Set<string>();
  const argv1 = process.argv[1];
  if (argv1) {
    entries.add(argv1);
  }
  const bunMain = typeof Bun !== "undefined" ? Bun.main : undefined;
  if (bunMain) {
    entries.add(bunMain);
  }

  const modulePaths = new Set<string>();
  for (const entry of entries) {
    try {
      modulePaths.add(createRequire(entry).resolve("@earendil-works/pi-tui"));
    } catch {
      // Some entry shims are not valid require roots; the manual walk covers them.
    }
    let dir = dirname(entry);
    while (true) {
      const candidate = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-tui",
        "dist",
        "index.js"
      );
      if (existsSync(candidate)) {
        modulePaths.add(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  for (const modulePath of modulePaths) {
    try {
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        TuiAltScreen?: unknown;
      };
      const ctor = mod.TuiAltScreen as AltScreenConstructor | undefined;
      if (typeof ctor === "function" && ctor.prototype) {
        constructors.add(ctor);
      }
    } catch {
      // Ignore unreadable copies; the others may still be the live one.
    }
  }

  return [...constructors];
}
