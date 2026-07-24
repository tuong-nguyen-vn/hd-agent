import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerThinkingMemory from "./index";

type Handler = (event: unknown, ctx: unknown) => unknown;

type MockPi = {
  readonly api: ExtensionAPI;
  readonly handlers: Map<string, Handler[]>;
  readonly setThinkingLevelCalls: string[];
  getLevel(): string;
  setLevel(level: string): void;
};

function createPi(initialLevel = "off"): MockPi {
  const handlers = new Map<string, Handler[]>();
  let level = initialLevel;
  const setThinkingLevelCalls: string[] = [];
  const api = {
    on(event: string, handler: Handler): void {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => {
      setThinkingLevelCalls.push(next);
      level = next;
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    handlers,
    setThinkingLevelCalls,
    getLevel: () => level,
    setLevel: (next: string) => {
      level = next;
    },
  };
}

async function emit(
  pi: MockPi,
  event: string,
  payload: unknown,
  ctx: unknown
): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler(payload, ctx);
  }
}

const modelA = { provider: "p", id: "a" };
const modelB = { provider: "p", id: "b" };

let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-thinking-memory-"));
});

beforeEach(async () => {
  process.env.PIM_HOME_DIR = testPimHomeDir;
  // Clean slate for each test: fresh temp dir means no on-disk settings yet.
  await rm(join(testPimHomeDir!, "settings.json"), { force: true });
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  if (testPimHomeDir) {
    await rm(testPimHomeDir, { recursive: true, force: true });
  }
});

describe("thinking-memory extension", () => {
  test("restores the last thinking level used on a model when switching back to it", async () => {
    const pi = createPi();
    await registerThinkingMemory(pi.api);

    // User picks "high" while on model A.
    pi.setLevel("high");
    await emit(
      pi,
      "thinking_level_select",
      { level: "high", previousLevel: "off" },
      { model: modelA }
    );

    // Core switches to model B, clamping the carried-over level to "off"
    // (simulating a model that doesn't expose any thinking levels).
    pi.setLevel("off");
    await emit(
      pi,
      "model_select",
      { model: modelB, previousModel: modelA, source: "set" },
      {}
    );
    expect(pi.setThinkingLevelCalls).toEqual([]);

    // Switching back to model A should restore "high" instead of staying "off".
    await emit(
      pi,
      "model_select",
      { model: modelA, previousModel: modelB, source: "set" },
      {}
    );
    expect(pi.setThinkingLevelCalls).toEqual(["high"]);
    expect(pi.getLevel()).toBe("high");
  });

  test("does nothing when the target model has no remembered level", async () => {
    const pi = createPi("off");
    await registerThinkingMemory(pi.api);

    await emit(
      pi,
      "model_select",
      { model: modelB, previousModel: modelA, source: "set" },
      {}
    );

    expect(pi.setThinkingLevelCalls).toEqual([]);
  });

  test("persists the selection to ~/.pim/settings.json", async () => {
    const pi = createPi();
    await registerThinkingMemory(pi.api);

    pi.setLevel("high");
    await emit(
      pi,
      "thinking_level_select",
      { level: "high", previousLevel: "off" },
      { model: modelA }
    );

    const stored = await Bun.file(
      join(testPimHomeDir!, "settings.json")
    ).json();
    expect(stored.thinkingLevels).toEqual({ "p/a": "high" });

    // A freshly registered extension instance picks up the persisted level
    // (e.g. after restarting the process) via PimSettings.getThinkingLevels().
    const restarted = createPi("off");
    await registerThinkingMemory(restarted.api);
    await emit(
      restarted,
      "model_select",
      { model: modelA, previousModel: modelB, source: "set" },
      {}
    );
    expect(restarted.setThinkingLevelCalls).toEqual(["high"]);
  });
});
