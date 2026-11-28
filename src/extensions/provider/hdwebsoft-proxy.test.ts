import { describe, expect, test } from "bun:test";
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

describe("HDWEBSOFT Proxy model catalog", () => {
  test("exposes SWE 2.1 while keeping the SWE 2 legacy id", () => {
    let registered: { models: Model[] } | undefined;
    const pi = {
      registerProvider: (_id: string, config: { models: Model[] }) => {
        registered = config;
      },
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI;

    registerHdwebsoftProxy(pi);

    const models = registered?.models ?? [];
    const swe21 = models.find((model) => model.id === "swe-2.1");
    const swe2 = models.find((model) => model.id === "swe-2");

    expect(swe21?.name).toBe("SWE 2.1");
    expect(swe2?.name).toBe("SWE 2");
    expect(swe21?.api).toBe("openai-completions");
    expect(swe21?.baseUrl).toBe(swe2?.baseUrl);
    expect(swe21?.contextWindow).toBe(262144);
    expect(swe21?.maxTokens).toBe(32768);
    expect(swe21?.thinkingLevelMap).toEqual(swe2?.thinkingLevelMap);
    expect(swe21?.compat).toEqual(swe2?.compat);
  });
});
