import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { generateSessionTitle } from "./generateTitle";

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

test("generateSessionTitle uses the configured model when available", async () => {
  const primary = model("google", "gemini-3.6-flash");
  const calls: string[] = [];
  const title = await generateSessionTitle(
    "transcript",
    context({ models: [primary], authenticated: [primary] }),
    undefined,
    async (_text, candidate) => {
      calls.push(`${candidate.provider}/${candidate.id}`);
      return "Fix auth token refresh bug";
    }
  );

  expect(title).toBe("Fix auth token refresh bug");
  expect(calls).toEqual(["google/gemini-3.6-flash"]);
});

test("generateSessionTitle falls back to the main model after primary failure", async () => {
  const primary = model("google", "gemini-3.6-flash");
  const fallback = model("openai", "main");
  const calls: string[] = [];
  const title = await generateSessionTitle(
    "transcript",
    context({ models: [primary], fallback, authenticated: [primary] }),
    undefined,
    async (_text, candidate) => {
      const key = `${candidate.provider}/${candidate.id}`;
      calls.push(key);
      if (candidate === primary) {
        throw new Error("primary down");
      }
      return "Add dark mode to settings";
    }
  );

  expect(title).toBe("Add dark mode to settings");
  expect(calls).toEqual(["google/gemini-3.6-flash", "openai/main"]);
});

test("generateSessionTitle throws with per-candidate diagnostics when everything fails", async () => {
  const primary = model("google", "gemini-3.6-flash");
  const fallback = model("openai", "main");
  await expect(
    generateSessionTitle(
      "transcript",
      context({ models: [primary], fallback, authenticated: [primary] }),
      undefined,
      async (_text, candidate) => {
        throw new Error(
          candidate === primary
            ? "no api key for google"
            : "no api key for openai"
        );
      }
    )
  ).rejects.toThrow(/no api key for google.*no api key for openai/s);
});

test("generateSessionTitle throws when no fallback is available and all candidates fail", async () => {
  const primary = model("google", "gemini-3.6-flash");
  await expect(
    generateSessionTitle(
      "transcript",
      context({ models: [primary], authenticated: [primary] }),
      undefined,
      async () => {
        throw new Error("down");
      }
    )
  ).rejects.toThrow("No main-agent fallback model");
});

test("generateSessionTitle avoids retrying the same model as the fallback", async () => {
  const primary = model("google", "gemini-3.6-flash");
  let calls = 0;
  await expect(
    generateSessionTitle(
      "transcript",
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

test("generateSessionTitle stops immediately once aborted", async () => {
  const primary = model("google", "gemini-3.6-flash");
  const controller = new AbortController();
  let calls = 0;
  const title = await generateSessionTitle(
    "transcript",
    context({ models: [primary], authenticated: [primary] }),
    controller.signal,
    async () => {
      calls += 1;
      controller.abort();
      throw new Error("aborted mid-flight");
    }
  );
  expect(title).toBeUndefined();
  expect(calls).toBe(1);
});
