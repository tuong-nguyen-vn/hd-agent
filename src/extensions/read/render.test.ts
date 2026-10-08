import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { formatTitlePath, renderTitlePath } from "./render";

function tracingTheme(): {
  readonly theme: Theme;
  readonly calls: { readonly color: ThemeColor; readonly text: string }[];
} {
  const calls: { color: ThemeColor; text: string }[] = [];
  return {
    calls,
    theme: {
      fg: (color: ThemeColor, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    } as unknown as Theme,
  };
}

describe("formatTitlePath", () => {
  const cwd = "/work/repo";

  test("renders relative path without format suffix", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
      })
    ).toBe("src/foo.ts");
  });

  test("renders explicit start-end range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 40,
        end: 80,
      })
    ).toBe("src/foo.ts @40-80");
  });

  test("renders start-only range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 40,
        end: undefined,
      })
    ).toBe("src/foo.ts @40");
  });

  test("falls back to absolute path when outside cwd", () => {
    expect(
      formatTitlePath({
        path: "/etc/hosts",
        cwd,
        start: undefined,
        end: undefined,
      })
    ).toBe("/etc/hosts");
  });

  test("placeholder when path is missing", () => {
    expect(
      formatTitlePath({
        path: undefined,
        cwd,
        start: undefined,
        end: undefined,
      })
    ).toBe("...");
  });

  test("uses the visible range after execution even when it's a partial read", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        outcome: { visibleStart: 1, visibleEnd: 7, totalLines: 20 },
      })
    ).toBe("src/foo.ts @1-7");
  });

  test("uses the actual visible end instead of an overlarge requested end", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 1,
        end: 999,
        outcome: { visibleStart: 1, visibleEnd: 7, totalLines: 20 },
      })
    ).toBe("src/foo.ts @1-7");
  });

  test("omits the range when the whole file was read", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        outcome: { visibleStart: 1, visibleEnd: 7, totalLines: 7 },
      })
    ).toBe("src/foo.ts");
  });
});

describe("renderTitlePath", () => {
  const cwd = "/work/repo";
  const PATH_FG = "\x1b[38;2;149;189;183m";
  const FG_RESET = "\x1b[39m";

  beforeEach(() => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  });

  afterEach(() => {
    resetCapabilitiesCache();
  });

  test("colors the path with Amp's link color and the range as a warning suffix", () => {
    const themed = tracingTheme();
    const title = renderTitlePath(
      {
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        outcome: { visibleStart: 1, visibleEnd: 7, totalLines: 20 },
      },
      themed.theme
    );

    expect(title).toBe(
      `${PATH_FG}src/foo.ts${FG_RESET} <warning>@1-7</warning>`
    );
    expect(themed.calls).toEqual([{ color: "warning", text: "@1-7" }]);
  });

  test("omits the range suffix when the whole file was read", () => {
    const themed = tracingTheme();
    const title = renderTitlePath(
      {
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        outcome: { visibleStart: 1, visibleEnd: 7, totalLines: 7 },
      },
      themed.theme
    );

    expect(title).toBe(`${PATH_FG}src/foo.ts${FG_RESET}`);
  });

  test("wraps the path in an OSC 8 hyperlink when the terminal supports it", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const themed = tracingTheme();

    const title = renderTitlePath(
      {
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
      },
      themed.theme
    );

    expect(title).toBe(
      `\x1b]8;;file:///work/repo/src/foo.ts\x1b\\${PATH_FG}src/foo.ts${FG_RESET}\x1b]8;;\x1b\\\x1b[0m`
    );
  });
});
