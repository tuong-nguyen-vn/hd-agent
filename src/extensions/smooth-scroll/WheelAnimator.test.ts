import { describe, expect, test } from "bun:test";
import { LINES_PER_NOTCH, nextStep } from "./WheelAnimator";

function drain(pending: number): number[] {
  const magnitudes: number[] = [];
  while (pending !== 0) {
    const step = nextStep(pending);
    magnitudes.push(step.direction * step.magnitude);
    pending = step.remaining;
    if (magnitudes.length > 1000) {
      throw new Error("animation did not converge");
    }
  }
  return magnitudes;
}

describe("nextStep", () => {
  test("a single notch glides one line per tick", () => {
    expect(drain(LINES_PER_NOTCH)).toEqual([1, 1, 1]);
  });

  test("drains exactly the pending distance", () => {
    for (const pending of [1, 3, 7, 30, 250]) {
      const total = drain(pending).reduce((sum, step) => sum + step, 0);
      expect(total).toBe(pending);
    }
  });

  test("eases out: steps never grow and always end at one line", () => {
    const magnitudes = drain(30).map(Math.abs);
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]).toBeLessThanOrEqual(magnitudes[i - 1] ?? 0);
    }
    expect(magnitudes.at(-1)).toBe(1);
    expect(magnitudes[0]).toBeGreaterThan(1);
  });

  test("scrolling up mirrors scrolling down", () => {
    expect(drain(-30)).toEqual(drain(30).map((step) => -step));
  });

  test("never emits a zero-magnitude step", () => {
    expect(nextStep(1)).toEqual({ direction: 1, magnitude: 1, remaining: 0 });
    expect(nextStep(-1)).toEqual({
      direction: -1,
      magnitude: 1,
      remaining: 0,
    });
  });
});
