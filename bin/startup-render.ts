import type { TUI as TuiType } from "@earendil-works/pi-tui";
import { detectCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_KEY = Symbol.for("amp-pi.startup-render");
const FAILSAFE_MS = 10_000;
const piCli = process.env["AMP_PI_CLI"];
const interactive = process.stdin.isTTY && process.stdout.isTTY;

// pi-tui's terminal detection doesn't recognise herdr (herdr.dev) since it
// isn't a terminal emulator and doesn't set TERM_PROGRAM/etc, so it falls
// back to the conservative `hyperlinks: false` default — file-path links
// never render as clickable OSC 8 links. Herdr does support opening OSC 8
// links (via Ctrl-click) and always sets HERDR_ENV=1 for panes it spawns, so
// seed the cache once at startup rather than special-casing every call site.
if (process.env["HERDR_ENV"] === "1") {
  setCapabilities({ ...detectCapabilities(), hyperlinks: true });
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
  )) as { readonly TUI: typeof TuiType };
  const { TUI } = piTui;
  const originalRequestRender = TUI.prototype.requestRender;
  const renderState: { pendingTui?: TuiType } = {};
  let released = false;

  TUI.prototype.requestRender = function (force = false): void {
    if (!released) {
      renderState.pendingTui = this;
      return;
    }
    originalRequestRender.call(this, force);
  };

  const release = (tui?: TuiType): void => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(failsafe);
    TUI.prototype.requestRender = originalRequestRender;
    const target = tui ?? renderState.pendingTui;
    if (target) {
      originalRequestRender.call(target, true);
    }
    renderState.pendingTui = undefined;
  };

  const failsafe = setTimeout(release, FAILSAFE_MS);
  failsafe.unref();

  (globalThis as Record<symbol, unknown>)[STATE_KEY] = { release };
}
