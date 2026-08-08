import type { TUI as TuiType } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_KEY = Symbol.for("amp-pi.startup-render");
const FAILSAFE_MS = 10_000;
const piCli = process.env["AMP_PI_CLI"];
const interactive = process.stdin.isTTY && process.stdout.isTTY;

if (piCli) {
  // pi's shutdown hint ("To resume this session: pi --session …") prints pi's own
  // APP_NAME. Rewrite the command token so the hint points at hd-agent instead.
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (
      typeof chunk === "string" &&
      chunk.includes("To resume this session:")
    ) {
      chunk = chunk.replace(/(^|\s)pi(?=\s+--session)/, "$1hd-agent");
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    );
  }) as typeof process.stdout.write;
}

const powerlineEnabled = async (): Promise<boolean> => {
  const settingsPath = join(
    process.env["PIM_HOME_DIR"] ?? join(homedir(), ".pim"),
    "settings.json"
  );
  try {
    const settings = (await Bun.file(settingsPath).json()) as {
      readonly powerline?: { readonly enabled?: boolean };
    };
    return settings.powerline?.enabled ?? true;
  } catch {
    return true;
  }
};

// The preload must never crash pi — if the render-suppression patch fails
// (e.g. pi-tui structure changed after a pi update but before hd-agent is
// updated), pi should still launch so the user can run pi update --extensions.
try {
  if (piCli && interactive && (await powerlineEnabled())) {
    const piDistDir = dirname(piCli);
    const settingsModule = (await import(
      pathToFileURL(join(piDistDir, "core", "settings-manager.js")).href
    )) as {
      readonly SettingsManager: {
        readonly prototype: { getQuietStartup(): boolean };
      };
    };
    settingsModule.SettingsManager.prototype.getQuietStartup = () => true;

    const requireFromPi = createRequire(piCli);
    const piTuiEntry = requireFromPi.resolve("@earendil-works/pi-tui");
    const piTui = (await import(
      pathToFileURL(join(dirname(piTuiEntry), "tui.js")).href
    )) as {
      readonly TuiBase?: new (...args: never[]) => TuiType;
      readonly TUI?: new (...args: never[]) => TuiType;
    };
    // pi-tui <0.84.0 exports a TUI class; 0.84.0+ exports TuiBase instead.
    const TuiCtor = piTui.TuiBase ?? piTui.TUI;
    if (TuiCtor) {
      const originalRequestRender = TuiCtor.prototype.requestRender;
      const originalRequestImmediateRender = TuiCtor.prototype
        .requestImmediateRender as ((this: TuiType) => void) | undefined;

      let released = false;
      let failsafe: ReturnType<typeof setTimeout> | null = null;
      // Captured from the real TUI instance (not Pi's Proxy) during blocked
      // requestRender calls. Used by release() to force a final render.
      let activeTui: TuiType | undefined;

      // Install permanent gated wrappers instead of repeatedly swapping the
      // prototype. This is safe under Pi 0.84.1's createInteractiveTuiReference
      // Proxy, which caches method references — every cached reference points
      // to the same stable wrapper that checks `released` at call time.
      TuiCtor.prototype.requestRender = function (force = false): void {
        if (!released) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          activeTui = this;
          return;
        }
        originalRequestRender.call(this, force);
      };

      if (typeof originalRequestImmediateRender === "function") {
        TuiCtor.prototype.requestImmediateRender = function (): void {
          if (!released) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            activeTui = this;
            return;
          }
          originalRequestImmediateRender.call(this);
        };
      }

      const suppress = (): void => {
        if (!released) {
          return;
        }
        released = false;
        // Cancel any render already queued on the active TUI. A pending
        // nextTick callback (from requestImmediateRender or scheduleRender)
        // would call doRender() directly, bypassing our gated wrappers.
        if (activeTui) {
          const t = activeTui as unknown as {
            renderRequested?: boolean;
            cancelRenderTimer?: () => void;
          };
          t.renderRequested = false;
          t.cancelRenderTimer?.();
        }
        failsafe = setTimeout(() => release(), FAILSAFE_MS);
        failsafe.unref();
      };

      const release = (tui?: TuiType): void => {
        if (released) {
          return;
        }
        released = true;
        if (failsafe) {
          clearTimeout(failsafe);
          failsafe = null;
        }
        // Prefer the real TUI captured during blocked renders over the Proxy
        // that Pi's editor factory passes in. If none was captured yet (e.g.
        // release before any blocked call), fall back to the argument.
        const target = activeTui ?? tui;
        if (target) {
          originalRequestRender.call(target, true);
        }
        activeTui = undefined;
      };

      // Start suppressed for initial startup.
      released = false;
      failsafe = setTimeout(() => release(), FAILSAFE_MS);
      failsafe.unref();

      (globalThis as Record<symbol, unknown>)[STATE_KEY] = {
        suppress,
        release,
      };
    }
  }
} catch {
  // Silently skip render suppression on failure — pi still launches.
}
