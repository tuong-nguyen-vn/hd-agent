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
    const renderState: { pendingTui?: TuiType } = {};
    let released = false;
    let failsafe: ReturnType<typeof setTimeout> | null = null;

    const patchRequestRender = (): void => {
      TuiCtor.prototype.requestRender = function (force = false): void {
        if (!released) {
          renderState.pendingTui = this;
          return;
        }
        originalRequestRender.call(this, force);
      };
    };

    const suppress = (): void => {
      if (!released) {
        return;
      }
      released = false;
      patchRequestRender();
      failsafe = setTimeout(release, FAILSAFE_MS);
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
      TuiCtor.prototype.requestRender = originalRequestRender;
      const target = tui ?? renderState.pendingTui;
      if (target) {
        originalRequestRender.call(target, true);
      }
      renderState.pendingTui = undefined;
    };

    patchRequestRender();
    failsafe = setTimeout(release, FAILSAFE_MS);
    failsafe.unref();

    (globalThis as Record<symbol, unknown>)[STATE_KEY] = { suppress, release };
  } // TuiCtor
}
