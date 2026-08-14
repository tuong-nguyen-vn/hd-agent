import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { summarizeSession } from "./summarize";

const model = (provider: string, id: string): Model<any> =>
  ({ provider, id }) as Model<any>;

function context(options: {
  readonly models: readonly Model<any>[];
  readonly fallback?: Model<any>;
  readonly authenticated?: readonly Model<any>[];
}): ExtensionContext {
  const authenticated = new Set(options.authenticated ?? []);
  return {
    cwd: "/work",
    model: options.fallback,
    modelRegistry: {
      getAll: () => [...options.models],
      hasConfiguredAuth: (candidate: Model<any>) =>
        authenticated.has(candidate),
    },
  } as unknown as ExtensionContext;
}

test("summarizeSession uses gemini-3.7-flash when available", async () => {
  const primary = model("google", "gemini-3.7-flash");
  const calls: string[] = [];
  const result = await summarizeSession(
    "transcript",
    context({ models: [primary], authenticated: [primary] }),
    undefined,
    async (_text, candidate) => {
      calls.push(`${candidate.provider}/${candidate.id}`);
      return { text: "summary", model: calls.at(-1)! };
    }
  );

  expect(result).toEqual({
    text: "summary",
    model: "google/gemini-3.7-flash",
    usedFallback: false,
  });
  expect(calls).toEqual(["google/gemini-3.7-flash"]);
});

test("summarizeSession falls back to the main model after primary failure", async () => {
  const primary = model("google", "gemini-3.7-flash");
  const fallback = model("openai", "main");
  const calls: string[] = [];
  const result = await summarizeSession(
    "transcript",
    context({ models: [primary], fallback, authenticated: [primary] }),
    undefined,
    async (_text, candidate) => {
      const key = `${candidate.provider}/${candidate.id}`;
      calls.push(key);
      if (candidate === primary) {
        throw new Error("primary down");
      }
      return { text: "fallback summary", model: key };
    }
  );

  expect(result.usedFallback).toBe(true);
  expect(result.model).toBe("openai/main");
  expect(calls).toEqual(["google/gemini-3.7-flash", "openai/main"]);
});

test("summarizeSession does not fall back after abort", async () => {
  const primary = model("google", "gemini-3.7-flash");
  const fallback = model("openai", "main");
  const controller = new AbortController();
  let calls = 0;
  await expect(
    summarizeSession(
      "transcript",
      context({ models: [primary], fallback, authenticated: [primary] }),
      controller.signal,
      async () => {
        calls += 1;
        controller.abort();
        throw new Error("aborted");
      }
    )
  ).rejects.toThrow("aborted");
  expect(calls).toBe(1);
});

test("summarizeSession reports missing fallback and avoids retrying the same model", async () => {
  const primary = model("google", "gemini-3.7-flash");
  await expect(
    summarizeSession(
      "x",
      context({ models: [primary], authenticated: [primary] }),
      undefined,
      async () => {
        throw new Error("down");
      }
    )
  ).rejects.toThrow("No main-agent fallback model");

  let calls = 0;
  await expect(
    summarizeSession(
      "x",
      context({
        models: [primary],
        fallback: primary,
        authenticated: [primary],
      }),
      undefined,
      async () => {
        calls += 1;
        throw new Error("down");
      }
    )
  ).rejects.toThrow("same model");
  expect(calls).toBe(1);
});

test("summarizeSession reports both primary and fallback failures", async () => {
  const primary = model("google", "gemini-3.7-flash");
  const fallback = model("openai", "main");
  await expect(
    summarizeSession(
      "x",
      context({ models: [primary], fallback, authenticated: [primary] }),
      undefined,
      async (_text, candidate) => {
        throw new Error(
          candidate === primary ? "primary failed" : "fallback failed"
        );
      }
    )
  ).rejects.toThrow(/primary failed.*fallback failed/);
});
