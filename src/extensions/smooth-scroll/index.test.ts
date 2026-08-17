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
  altScreenActive: boolean;
  renderRequests: number;
  getPrimaryScrollView(): unknown;
  updateScrollbarHover(): void;
  requestRender(): void;
  routeWheel(event: { direction: 1 | -1; x: number; y: number }): void;
  doRender(): void;
};

function makeFakeAltScreen(scrolls: number[]): FakeAltScreen {
  // A bare object on the real prototype exercises the patched routeWheel and
  // doRender, and the stock routing underneath them, without constructing a
  // terminal. altScreenActive=false makes the stock doRender a no-op so each
  // doRender() call stands in for one rendered frame.
  const self = Object.create(TuiAltScreen.prototype) as FakeAltScreen;
  self.wheelScrollLines = 1;
  self.currentLayout = undefined;
  self.altScreenActive = false;
  self.renderRequests = 0;
  self.getPrimaryScrollView = () => ({
    scrollBy: (lines: number) => {
      scrolls.push(lines);
      return 0;
    },
  });
  self.updateScrollbarHover = () => {};
  self.requestRender = () => {
    self.renderRequests++;
  };
  return self;
}

function renderUntilSettled(self: FakeAltScreen, scrolls: number[]): void {
  for (let frame = 0; frame < 1000; frame++) {
    const before = scrolls.length;
    self.doRender();
    if (scrolls.length === before) {
      return;
    }
  }
  throw new Error("animation did not converge");
}

describe("smooth-scroll patch", () => {
  test("patches the live TuiAltScreen prototype exactly once", async () => {
    const prototype = TuiAltScreen.prototype as unknown as {
      routeWheel?: unknown;
      doRender?: unknown;
    };
    expect(typeof prototype.routeWheel).toBe("function");
    expect(typeof prototype.doRender).toBe("function");
    await installPatch();
    const patchedRouteWheel = prototype.routeWheel;
    const patchedDoRender = prototype.doRender;
    await installPatch();
    expect(prototype.routeWheel).toBe(patchedRouteWheel);
    expect(prototype.doRender).toBe(patchedDoRender);
  });

  test("a notch schedules a frame and moves only when frames render", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    self.routeWheel({ direction: 1, x: 0, y: 0 });
    expect(scrolls).toEqual([]);
    expect(self.renderRequests).toBe(1);

    self.doRender();
    self.doRender();
    self.doRender();
    expect(scrolls).toEqual([1, 1, 1]);

    // Drained: further frames neither move nor request more frames.
    const requestsAfterDrain = self.renderRequests;
    self.doRender();
    expect(scrolls).toEqual([1, 1, 1]);
    expect(self.renderRequests).toBe(requestsAfterDrain);
  });

  test("each frame consumes exactly one eased step", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    for (let notch = 0; notch < 10; notch++) {
      self.routeWheel({ direction: -1, x: 0, y: 0 });
    }
    renderUntilSettled(self, scrolls);
    expect(scrolls.reduce((sum, lines) => sum + lines, 0)).toBe(
      -10 * LINES_PER_NOTCH
    );
    // Ease-out: step sizes never grow and always land at a single line.
    const magnitudes = scrolls.map(Math.abs);
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]).toBeLessThanOrEqual(magnitudes[i - 1] ?? 0);
    }
    expect(scrolls.at(-1)).toBe(-1);
  });

  test("mid-glide notches fold into the remaining distance", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    for (let notch = 0; notch < 5; notch++) {
      self.routeWheel({ direction: 1, x: 0, y: 0 });
    }
    self.doRender();
    for (let notch = 0; notch < 5; notch++) {
      self.routeWheel({ direction: 1, x: 0, y: 0 });
    }
    renderUntilSettled(self, scrolls);
    expect(scrolls.reduce((sum, lines) => sum + lines, 0)).toBe(
      10 * LINES_PER_NOTCH
    );
  });

  test("reversing direction cancels outstanding distance instead of oscillating", async () => {
    await installPatch();
    const scrolls: number[] = [];
    const self = makeFakeAltScreen(scrolls);

    for (let notch = 0; notch < 5; notch++) {
      self.routeWheel({ direction: 1, x: 0, y: 0 });
    }
    for (let notch = 0; notch < 5; notch++) {
      self.routeWheel({ direction: -1, x: 0, y: 0 });
    }
    renderUntilSettled(self, scrolls);
    expect(scrolls.reduce((sum, lines) => sum + lines, 0)).toBe(0);
  });
});
