import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import fullscreenCopy from "./index";

type SessionStartHandler = () => Promise<void> | void;

type FakeAltScreen = {
  readonly writes: string[];
  readonly flashes: string[];
  readonly terminal: { write(data: string): void };
  copySelection?: (text: string) => Promise<boolean | string>;
  flash(message: string): void;
  copyTextToClipboard(text: string): Promise<boolean>;
};

function makeFakeAltScreen(
  copySelection: FakeAltScreen["copySelection"]
): FakeAltScreen {
  const self = Object.create(TuiAltScreen.prototype) as FakeAltScreen;
  const writes: string[] = [];
  const flashes: string[] = [];
  Object.assign(self, {
    writes,
    flashes,
    terminal: { write: (data: string) => writes.push(data) },
    copySelection,
    flash: (message: string) => flashes.push(message),
  });
  return self;
}

const originalTermProgram = process.env["TERM_PROGRAM"];

beforeAll(async () => {
  process.env["TERM_PROGRAM"] = "Orca";
  let handler: SessionStartHandler | undefined;
  const pi = {
    on: (event: string, cb: SessionStartHandler) => {
      if (event === "session_start") {
        handler = cb;
      }
    },
  } as unknown as ExtensionAPI;
  fullscreenCopy(pi);
  await handler?.();
});

afterAll(() => {
  if (originalTermProgram === undefined) {
    delete process.env["TERM_PROGRAM"];
  } else {
    process.env["TERM_PROGRAM"] = originalTermProgram;
  }
});

describe("fullscreen copy under Orca", () => {
  test("sends OSC 52 alongside the native copy", async () => {
    const copied: string[] = [];
    const self = makeFakeAltScreen(async (text) => {
      copied.push(text);
      return true;
    });

    expect(await self.copyTextToClipboard("héllo")).toBe(true);

    expect(self.writes).toEqual([
      `\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`,
    ]);
    expect(copied).toEqual(["héllo"]);
    expect(self.flashes).toEqual(["Copied!"]);
  });

  test("reports success when only the native copy fails", async () => {
    const self = makeFakeAltScreen(async () => "Clipboard unavailable");

    expect(await self.copyTextToClipboard("text")).toBe(true);

    expect(self.writes).toHaveLength(1);
    expect(self.flashes).toEqual(["Copied!"]);
  });

  test("leaves oversized text to pi's own copy", async () => {
    const self = makeFakeAltScreen(async () => "Clipboard unavailable");

    expect(await self.copyTextToClipboard("x".repeat(80_000))).toBe(false);

    expect(self.writes).toEqual([]);
    expect(self.flashes).toEqual(["Clipboard unavailable"]);
  });
});
