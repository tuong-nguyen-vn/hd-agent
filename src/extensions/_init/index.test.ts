import { describe, expect, test } from "bun:test";

describe("_init unhandledRejection guard", () => {
  test("swallows AbortError, logs everything else", async () => {
    await import("./index.ts");
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const abortedPromise = Promise.reject(
      new DOMException("aborted", "AbortError")
    );
    const boomPromise = Promise.reject(new Error("boom"));
    abortedPromise.catch(() => {});
    boomPromise.catch(() => {});
    try {
      process.emit(
        "unhandledRejection",
        new DOMException("aborted", "AbortError"),
        abortedPromise
      );
      process.emit("unhandledRejection", new Error("boom"), boomPromise);
    } finally {
      console.error = originalError;
    }
    expect(logged.length).toBe(1);
    expect(String(logged[0])).toContain("boom");
  });
});

describe("_init uncaughtException guard", () => {
  test("swallows synchronous AbortError, logs everything else", async () => {
    await import("./index.ts");
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      process.emit(
        "uncaughtException",
        new DOMException("aborted", "AbortError")
      );
      process.emit("uncaughtException", new Error("boom"));
    } finally {
      console.error = originalError;
    }
    expect(logged.length).toBe(1);
    expect(String(logged[0])).toContain("boom");
  });
});
