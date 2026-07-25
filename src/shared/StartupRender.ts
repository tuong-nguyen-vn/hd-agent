import type { TUI } from "@earendil-works/pi-tui";

const STATE_KEY = Symbol.for("amp-pi.startup-render");

type StartupRenderState = {
  readonly release: (tui?: TUI) => void;
};

export class StartupRender {
  public static release(tui?: TUI): void {
    const state = (globalThis as Record<symbol, unknown>)[STATE_KEY] as
      | StartupRenderState
      | undefined;
    state?.release(tui);
  }
}
