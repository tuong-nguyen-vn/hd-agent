const KEY = Symbol.for("pim.journal-line");

type State = {
  text: string | undefined;
  requestRender?: () => void;
  onToggle?: () => void;
};

/**
 * Cross-module bridge between the journal extension and the powerline
 * editor, mirroring the ActivityLine design: stored on globalThis because
 * the editor and the extension may resolve through different pi module
 * copies.
 */
export class JournalLine {
  private static state(): State {
    const g = globalThis as Record<symbol, State | undefined>;
    g[KEY] ??= { text: undefined };
    return g[KEY];
  }

  public static setText(text: string | undefined): void {
    const s = this.state();
    if (s.text !== text) {
      s.text = text;
      try {
        s.requestRender?.();
      } catch {
        // Same reasoning as ActivityLine: repaint misses are harmless.
      }
    }
  }

  public static getText(): string | undefined {
    return this.state().text;
  }

  public static setRenderTrigger(requestRender: () => void): void {
    this.state().requestRender = requestRender;
  }

  public static setOnToggle(onToggle: (() => void) | undefined): void {
    this.state().onToggle = onToggle;
  }

  public static toggle(): void {
    this.state().onToggle?.();
  }

  public static resetForTests(): void {
    (globalThis as Record<symbol, State | undefined>)[KEY] = undefined;
  }
}
