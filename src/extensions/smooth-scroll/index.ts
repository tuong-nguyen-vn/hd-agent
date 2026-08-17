import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WheelAnimator, type WheelEventInput } from "./WheelAnimator";

const PATCH_STATE = Symbol.for("pim.smooth-scroll");
const ANIMATOR = Symbol.for("pim.smooth-scroll-animator");

type AltScreenInstance = {
  wheelScrollLines: number;
  routeWheel(event: WheelEventInput): void;
  doRender(): void;
  requestRender(): void;
  [ANIMATOR]?: WheelAnimator;
};

type AltScreenPrototype = AltScreenInstance & {
  [PATCH_STATE]?: true;
};

type AltScreenConstructor = Function & {
  readonly prototype: AltScreenPrototype;
};

function isAltScreenConstructor(value: unknown): value is AltScreenConstructor {
  const ctor = value as AltScreenConstructor | undefined;
  return (
    typeof ctor === "function" &&
    !!ctor.prototype &&
    typeof ctor.prototype.routeWheel === "function" &&
    typeof ctor.prototype.doRender === "function"
  );
}

/**
 * HD Agent can end up with two `pi-tui` copies: one hoisted next to the
 * extension and one nested in the installed package tree. Patching only the
 * imported copy leaves the running UI on the other class, so the smoothing
 * silently never engages. Resolve every reachable copy from the CLI entry.
 */
async function resolveAltScreenConstructors(): Promise<AltScreenConstructor[]> {
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
      if (isAltScreenConstructor(mod.TuiAltScreen)) {
        constructors.add(mod.TuiAltScreen);
      }
    } catch {
      // Ignore unreadable copies; the others may still be the live one.
    }
  }

  return [...constructors];
}

// The reachable pi-tui copies are fixed for the process lifetime (a /reload
// re-imports this module, resetting the cache); resolve once instead of
// re-walking the filesystem on every session_start.
let constructorsPromise: Promise<AltScreenConstructor[]> | undefined;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    constructorsPromise ??= resolveAltScreenConstructors();
    for (const ctor of await constructorsPromise) {
      const prototype = ctor.prototype;
      if (prototype[PATCH_STATE]) {
        continue;
      }

      const originalRouteWheel = prototype.routeWheel;
      const originalDoRender = prototype.doRender;
      prototype[PATCH_STATE] = true;
      prototype.routeWheel = function (event: WheelEventInput): void {
        const self = this as AltScreenInstance;
        (self[ANIMATOR] ??= new WheelAnimator()).onWheel(event);
        self.requestRender();
      };
      // Render-driven stepping: each painted frame consumes exactly one eased
      // step, so the glide's pacing matches the real frame rate and slow
      // frames coalesce distance instead of queuing behind a timer.
      prototype.doRender = function (): void {
        const self = this as AltScreenInstance;
        const step = self[ANIMATOR]?.takeStep();
        if (step) {
          // Drive the stock routing (nested scroll views, scrollbar hover,
          // and the requestRender that keeps the glide going) with the eased
          // step size: wheelScrollLines is the multiplier routeWheel applies
          // to a single notch.
          self.wheelScrollLines = step.magnitude;
          originalRouteWheel.call(self, {
            direction: step.direction,
            x: step.x,
            y: step.y,
          });
        }
        originalDoRender.call(self);
      };
    }
  });
}
