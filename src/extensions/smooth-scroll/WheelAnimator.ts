export type WheelEventInput = {
  readonly direction: 1 | -1;
  readonly x: number;
  readonly y: number;
};

export type WheelStep = {
  readonly direction: 1 | -1;
  readonly magnitude: number;
  readonly x: number;
  readonly y: number;
};

export const LINES_PER_NOTCH = 3;
const EASE = 0.4;

export function nextStep(pending: number): {
  readonly direction: 1 | -1;
  readonly magnitude: number;
  readonly remaining: number;
} {
  const direction: 1 | -1 = pending > 0 ? 1 : -1;
  const magnitude = Math.max(1, Math.round(Math.abs(pending) * EASE));
  return { direction, magnitude, remaining: pending - direction * magnitude };
}

/**
 * Accumulates wheel notches into an outstanding scroll distance and hands out
 * one eased step per rendered frame (render-driven, like
 * requestAnimationFrame): fast flicks start with large steps while every
 * gesture lands one line at a time. Pacing steps by actual frames keeps the
 * glide perfectly even and degrades gracefully — slow frames coalesce into
 * bigger steps instead of queuing up, and no timer exists to orphan.
 */
export class WheelAnimator {
  private pending = 0;
  private last: WheelEventInput | undefined;

  onWheel(event: WheelEventInput): void {
    this.last = event;
    this.pending += event.direction * LINES_PER_NOTCH;
  }

  takeStep(): WheelStep | undefined {
    const last = this.last;
    if (this.pending === 0 || last === undefined) {
      return undefined;
    }
    const { direction, magnitude, remaining } = nextStep(this.pending);
    this.pending = remaining;
    return { direction, magnitude, x: last.x, y: last.y };
  }
}
