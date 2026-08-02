import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { DiffLines } from "../../shared/DiffLines";
import { DiffView, type DiffRenderState } from "../../shared/DiffView";
import { Renderer } from "../../shared/Renderer";

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

describe("DiffView.countStats", () => {
  test("returns zeros when diff is undefined", () => {
    expect(DiffView.countStats(undefined)).toEqual({ added: 0, removed: 0 });
  });

  test("counts added and removed lines across hunks", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      {
        lines: ["alpha", "beta", "gamma", "delta"],
        hasTrailingNewline: true,
      },
      {
        lines: ["alpha", "BETA", "gamma", "DELTA"],
        hasTrailingNewline: true,
      },
      0
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 2, removed: 2 });
  });

  test("counts a brand-new file as all added", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/new.ts",
      { lines: [], hasTrailingNewline: false },
      { lines: ["one", "two", "three"], hasTrailingNewline: true },
      0
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 3, removed: 0 });
  });
});

describe("DiffView.buildBlock (collapsed diff preview)", () => {
  function longDiff(lineCount: number) {
    return DiffLines.buildToolDiff(
      "/tmp/long.txt",
      { lines: [], hasTrailingNewline: false },
      {
        lines: Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`),
        hasTrailingNewline: true,
      },
      0
    )!;
  }

  test("renders every line when the diff fits within previewLines", () => {
    const container = DiffView.buildBlock({
      diff: longDiff(5),
      theme: stubTheme,
      lastComponent: undefined,
      expanded: false,
      previewLines: 20,
    });

    const lines = container.render(200);
    expect(lines.some((l) => l.includes("line 1"))).toBe(true);
    expect(lines.some((l) => l.includes("line 5"))).toBe(true);
    expect(lines.some((l) => l.includes("⋯"))).toBe(false);
    expect(lines.every((line) => !line.startsWith(" │"))).toBe(true);
  });

  test("collapses to the last previewLines lines with a leading marker when not expanded", () => {
    const container = DiffView.buildBlock({
      diff: longDiff(30),
      theme: stubTheme,
      lastComponent: undefined,
      expanded: false,
      previewLines: 20,
    });

    const lines = container.render(200);
    expect(lines.some((l) => l.includes("   ⋯"))).toBe(true);
    expect(lines.some((l) => /\bline 1\b/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes("line 11"))).toBe(true);
    expect(lines.some((l) => l.includes("line 30"))).toBe(true);
  });

  test("renders every line when expanded, regardless of previewLines", () => {
    const container = DiffView.buildBlock({
      diff: longDiff(30),
      theme: stubTheme,
      lastComponent: undefined,
      expanded: true,
      previewLines: 20,
    });

    const lines = container.render(200);
    expect(lines.some((l) => l.includes("⋯"))).toBe(false);
    expect(lines.some((l) => /\bline 1\b/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("line 30"))).toBe(true);
  });
});

describe("DiffView.formatStats", () => {
  test("emits both segments separated by a space", () => {
    expect(DiffView.formatStats({ added: 5, removed: 2 }, stubTheme)).toBe(
      "<toolDiffAdded>+5</toolDiffAdded> <toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("omits the removed segment when zero", () => {
    expect(DiffView.formatStats({ added: 5, removed: 0 }, stubTheme)).toBe(
      "<toolDiffAdded>+5</toolDiffAdded>"
    );
  });

  test("omits the added segment when zero", () => {
    expect(DiffView.formatStats({ added: 0, removed: 2 }, stubTheme)).toBe(
      "<toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("returns empty string when both are zero", () => {
    expect(DiffView.formatStats({ added: 0, removed: 0 }, stubTheme)).toBe("");
  });
});

describe("DiffView.renderDiffCall with write's opt-in styling", () => {
  const originalHerdrEnv = process.env["HERDR_ENV"];

  beforeEach(() => {
    // Renderer.renderFileLink treats HERDR_ENV=1 as a hyperlink-capable
    // terminal regardless of setCapabilities(), so isolate it per test.
    delete process.env["HERDR_ENV"];
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  });

  afterEach(() => {
    if (originalHerdrEnv === undefined) {
      delete process.env["HERDR_ENV"];
    } else {
      process.env["HERDR_ENV"] = originalHerdrEnv;
    }
    resetCapabilitiesCache();
  });

  function callContext() {
    return {
      state: {} as DiffRenderState,
      cwd: "/work/repo",
      isPartial: false,
      isError: false,
      lastComponent: undefined,
    };
  }

  test("uses a space separator instead of a colon after the label", () => {
    const context = callContext();
    const component = DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/foo.ts",
      theme: stubTheme,
      context,
      separator: " ",
      markerGlyph: Renderer.markerGlyphFor,
      link: true,
    });

    const line = component.render(80)[0] ?? "";
    expect(line).toContain("Create</bold>");
    expect(line).not.toContain(": ");
  });

  test("shows a check mark on success and a cross on error", () => {
    const successContext = callContext();
    DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/foo.ts",
      theme: stubTheme,
      context: successContext,
      markerGlyph: Renderer.markerGlyphFor,
    });
    expect(successContext.lastComponent).toBeUndefined();

    const successComponent = DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/foo.ts",
      theme: stubTheme,
      context: { ...callContext(), isError: false },
      markerGlyph: Renderer.markerGlyphFor,
    });
    expect(successComponent.render(80)[0]).toContain("✓");

    const errorComponent = DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/foo.ts",
      theme: stubTheme,
      context: { ...callContext(), isError: true },
      markerGlyph: Renderer.markerGlyphFor,
    });
    expect(errorComponent.render(80)[0]).toContain("✗");
  });

  test("styles only the path without an OSC hyperlink", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const context = callContext();
    const component = DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/foo.ts",
      theme: stubTheme,
      context,
      link: true,
      clickableLink: false,
      padTitle: false,
    });

    const rendered = component.render(80);
    const line = rendered.join("");
    expect(line).toContain("\x1b[38;2;149;189;183msrc/foo.ts\x1b[39m\u200b");
    expect(line).not.toContain("\x1b]8;;");
    expect(line.endsWith(" ")).toBe(false);
  });

  test("uses spinner when isPartial is true and invalidate is provided", () => {
    const invalidate = () => {};
    const partialContext = {
      ...callContext(),
      isPartial: true,
      executionStarted: true,
      invalidate,
    };

    const component = DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/foo.ts",
      theme: stubTheme,
      context: partialContext,
      markerGlyph: Renderer.markerGlyphFor,
      link: true,
    });

    expect(component.render(80)[0]).toContain("⠹");

    const restored = DiffView.renderDiffCall({
      label: "Create",
      rawPath: "/work/repo/src/restored.ts",
      theme: stubTheme,
      context: {
        ...callContext(),
        isPartial: true,
        executionStarted: false,
        invalidate,
      },
      markerGlyph: Renderer.markerGlyphFor,
      link: true,
    });
    expect(restored.render(80)[0]).toContain("▪");
    expect(restored.render(80)[0]).not.toContain("⠹");

    DiffView.renderDiffResult({
      label: "Create",
      result: { content: [{ type: "text", text: "done" }], details: {} },
      options: { expanded: false, isPartial: false },
      theme: stubTheme,
      context: {
        state: partialContext.state,
        isError: false,
        lastComponent: undefined,
        invalidate,
      },
      previewLines: 5,
      diffPreviewLines: 20,
      markerGlyph: Renderer.markerGlyphFor,
    });
    expect(component.render(80)[0]).toContain("✓");
  });
});
