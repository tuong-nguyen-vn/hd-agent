import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import smoothScroll from "./index";
import { LINES_PER_NOTCH } from "./WheelAnimator";

type SessionStartHandler = () => Promise<void> | void;

async function installPatch(): Promise<void> {
  let handler: SessionStartHandler | undefined;
  const pi = {
    on: (event: string, cb: SessionStartHandler) => {
      if (event === "session_start") {
        handler = cb;
      }
    },
  } as unknown as ExtensionAPI;
  smoothScroll(pi);
  if (!handler) {
    throw new Error("smooth-scroll did not subscribe to session_start");
  }
  await handler();
}

type FakeAltScreen = {
  wheelScrollLines: number;
  currentLayout: undefined;
  getPrimaryScrollView(): unknown;
  updateScrollbarHover(): void;
  requestRender(): void;
  routeWheel(event: { direction: 1 | -1; x: number; y: number }): void;
};

function makeFakeAltScreen(scrolls: number[]): FakeAltScreen {
  // A bare object on the real prototype exercises the patched routeWheel and
  // the stock routing underneath it without constructing a terminal.
  const self = Object.create(TuiAltScreen.prototype) as FakeAltScreen;
  self.wheelScrollLines = 1;
  self.currentLayout = undefined;
  self.getPrimaryScrollView = () => ({
    scrollBy: (lines: number) => {
      scrolls.push(lines);
      return 0;
    },
  });
  self.updateScrollbarHover = () => {};
  self.requestRender = () => {};
  return self;
}

async function drainAnimation(scrolls: number[]): Promise<void> {
  const deadline = Date.now() + 1000;
  let settledLength = scrolls.length;
  let settledSince = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(20);
    if (scrolls.length !== settledLength) {
      settledLength = scrolls.length;
      settledSince = Date.now();
    } else if (Date.now() - settledSince > 100) {
      return;
    }
  }
}

describe("smooth-scroll patch", () => {
  test("patches the live TuiAltScreen prototype exactly once", async () => {
    const prototype = TuiAltScreen.prototype as unknown as {
      routeWheel?: unknown;
    };
    expect(typeof prototype.routeWheel).toBe("function");
    await installPatch();
    const patched = prototype.routeWheel;
    expect(typeof patched).toBe("function");
    await installPatch();
    expect(prototype.routeWheel).toBe(patched);
  });

  test("one notch scrolls LINES_PER_NOTCH lines, spread over eased steps", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    self.routeWheel({ direction: 1, x: 0, y: 0 });
    // The first step fires synchronously so a notch responds within the frame.
    expect(scrolls.length).toBeGreaterThanOrEqual(1);
    await drainAnimation(scrolls);
    expect(scrolls.reduce((sum, lines) => sum + lines, 0)).toBe(
      LINES_PER_NOTCH
    );
    expect(scrolls.every((lines) => lines >= 1)).toBe(true);
  });

  test("a flick accumulates distance and eases out to single lines", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    for (let notch = 0; notch < 10; notch++) {
      self.routeWheel({ direction: -1, x: 0, y: 0 });
    }
    await drainAnimation(scrolls);
    expect(scrolls.reduce((sum, lines) => sum + lines, 0)).toBe(
      -10 * LINES_PER_NOTCH
    );
    expect(scrolls.every((lines) => lines <= -1)).toBe(true);
    expect(scrolls.at(-1)).toBe(-1);
  });

  test("reversing direction mid-glide converges instead of oscillating", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    for (let notch = 0; notch < 5; notch++) {
      self.routeWheel({ direction: 1, x: 0, y: 0 });
    }
    for (let notch = 0; notch < 5; notch++) {
      self.routeWheel({ direction: -1, x: 0, y: 0 });
    }
    await drainAnimation(scrolls);
    expect(scrolls.reduce((sum, lines) => sum + lines, 0)).toBe(0);
  });
});
