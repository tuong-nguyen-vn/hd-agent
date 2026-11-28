import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHdwebsoftProxy } from "./hdwebsoft-proxy";

type Model = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: Record<string, string | null>;
  compat: Record<string, unknown>;
};

const TEST_ROOT = "https://hdproxy.internal.invalid";
const ENV_KEY = "HDWEBSOFT_PROXY_ROOT";

function createPiStub(): {
  pi: ExtensionAPI;
  registered: () => { models: Model[] } | undefined;
} {
  let registered: { models: Model[] } | undefined;
  const pi = {
    registerProvider: (_id: string, config: { models: Model[] }) => {
      registered = config;
    },
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI;
  return { pi, registered: () => registered };
}

describe("HDWEBSOFT Proxy model catalog", () => {
  const saved = process.env[ENV_KEY];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  test("exposes SWE 2.1 while keeping the SWE 2 legacy id", () => {
    process.env[ENV_KEY] = TEST_ROOT;
    const { pi, registered } = createPiStub();

    registerHdwebsoftProxy(pi);

    const models = registered()?.models ?? [];
    const swe21 = models.find((model) => model.id === "swe-2.1");
    const swe2 = models.find((model) => model.id === "swe-2");

    expect(swe21?.name).toBe("SWE 2.1");
    expect(swe2?.name).toBe("SWE 2");
    expect(swe21?.api).toBe("openai-completions");
    expect(swe21?.baseUrl).toBe(`${TEST_ROOT}/v1`);
    expect(swe2?.baseUrl).toBe(`${TEST_ROOT}/v1`);
    expect(swe21?.contextWindow).toBe(262144);
    expect(swe21?.maxTokens).toBe(32768);
    expect(swe21?.thinkingLevelMap).toEqual(swe2?.thinkingLevelMap);
    expect(swe21?.compat).toEqual(swe2?.compat);
  });

  test("derives every model baseUrl from HDWEBSOFT_PROXY_ROOT", () => {
    process.env[ENV_KEY] = `${TEST_ROOT}/`;
    const { pi, registered } = createPiStub();

    registerHdwebsoftProxy(pi);

    const models = registered()?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.baseUrl.startsWith(`${TEST_ROOT}/`)).toBe(true);
      expect(model.baseUrl).not.toContain("//v");
    }
  });

  test("skips provider registration when the env root is not set", () => {
    delete process.env[ENV_KEY];
    const { pi, registered } = createPiStub();

    registerHdwebsoftProxy(pi);

    expect(registered()).toBeUndefined();
  });
});
