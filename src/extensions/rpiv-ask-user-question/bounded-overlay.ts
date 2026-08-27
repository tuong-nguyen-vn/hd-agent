import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";

// Upstream opens its questionnaire as a bottom-anchored overlay with
// `maxHeight: "100%"`, so a tall question list hides the assistant text that
// led to it. Capping the overlay leaves the top of the transcript readable
// without relying on the user knowing the collapse shortcut.
export const OVERLAY_MAX_HEIGHT_PERCENT = 70;

// Mirrors pi-tui's `parseSizeValue` + clamp for a percentage `maxHeight` with
// zero vertical margins. Upstream's DialogView sizes its scroll window from
// `tui.terminal.rows`, while pi-tui slices the rendered lines at `maxHeight`;
// feeding the dialog this exact number keeps the footer from being cut off.
export function boundedRows(terminalRows: number): number {
  const capped = Math.floor((terminalRows * OVERLAY_MAX_HEIGHT_PERCENT) / 100);
  return Math.max(1, Math.min(capped, terminalRows));
}

type CustomUi = ExtensionContext["ui"]["custom"];
type CustomOptions = NonNullable<Parameters<CustomUi>[1]>;
type CustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void
) => ReturnType<Parameters<CustomUi>[0]>;

function bindMethods<T extends object>(target: T, overrides: object): T {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return Reflect.get(overrides, prop);
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

export function boundedTui(tui: TUI): TUI {
  const terminal = bindMethods(tui.terminal, {
    get rows() {
      return boundedRows(tui.terminal.rows);
    },
  });
  return bindMethods(tui, { terminal });
}

function boundedOverlayOptions(options: CustomOptions): CustomOptions {
  const resolve = (): OverlayOptions => {
    const base =
      typeof options.overlayOptions === "function"
        ? options.overlayOptions()
        : options.overlayOptions;
    return { ...base, maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%` };
  };
  return { ...options, overlayOptions: resolve() };
}

export function boundedOverlayContext(ctx: ExtensionContext): ExtensionContext {
  const custom: CustomUi = <T>(
    factory: CustomFactory<T>,
    options?: CustomOptions
  ): Promise<T> => {
    if (!options?.overlay) {
      return ctx.ui.custom<T>(factory, options);
    }
    const wrappedFactory: CustomFactory<T> = (tui, theme, keybindings, done) =>
      factory(boundedTui(tui), theme, keybindings, done);
    return ctx.ui.custom<T>(wrappedFactory, boundedOverlayOptions(options));
  };
  return bindMethods(ctx, { ui: bindMethods(ctx.ui, { custom }) });
}

export function withBoundedOverlay<T extends ToolDefinition>(def: T): T {
  return {
    ...def,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      def.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        boundedOverlayContext(ctx)
      ),
  };
}
