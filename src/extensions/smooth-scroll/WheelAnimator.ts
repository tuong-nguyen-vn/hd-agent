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
export const TICK_MS = 16;
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
 * Turns discrete wheel notches into an eased glide: each notch adds
 * LINES_PER_NOTCH to the outstanding scroll distance and every tick drains a
 * fraction of it, so fast flicks start with large steps while every gesture
 * lands one line at a time. The interval only exists while distance remains,
 * so an abandoned animator stops itself within a few ticks.
 */
export class WheelAnimator {
  private pending = 0;
  private last: WheelEventInput | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly step: (step: WheelStep) => void) {}

  onWheel(event: WheelEventInput): void {
    this.last = event;
    this.pending += event.direction * LINES_PER_NOTCH;
    this.tick();
    if (this.pending !== 0 && this.timer === undefined) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref();
    }
  }

  private tick(): void {
    const last = this.last;
    if (this.pending === 0 || last === undefined) {
      this.stop();
      return;
    }
    const { direction, magnitude, remaining } = nextStep(this.pending);
    this.pending = remaining;
    this.step({ direction, magnitude, x: last.x, y: last.y });
    if (this.pending === 0) {
      this.stop();
    }
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
