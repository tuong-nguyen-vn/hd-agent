import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AltScreen, type AltScreenConstructor } from "../../shared/AltScreen";
import { WheelAnimator, type WheelEventInput } from "./WheelAnimator";

const PATCH_STATE = Symbol.for("pim.smooth-scroll");
const ANIMATOR = Symbol.for("pim.smooth-scroll-animator");

type AltScreenInstance = {
  routeWheel(event: WheelEventInput, delta: number): void;
  doRender(): void;
  requestRender(): void;
  [ANIMATOR]?: WheelAnimator;
};

type AltScreenPrototype = AltScreenInstance & {
  [PATCH_STATE]?: true;
};

function hasWheelRouting(
  value: AltScreenConstructor
): value is AltScreenConstructor & { readonly prototype: AltScreenPrototype } {
  const prototype = value.prototype as Partial<AltScreenPrototype>;
  return (
    typeof prototype.routeWheel === "function" &&
    typeof prototype.doRender === "function"
  );
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    for (const ctor of await AltScreen.constructors()) {
      if (!hasWheelRouting(ctor)) {
        continue;
      }
      const prototype = ctor.prototype;
      if (prototype[PATCH_STATE]) {
        continue;
      }

      const originalRouteWheel = prototype.routeWheel;
      const originalDoRender = prototype.doRender;
      prototype[PATCH_STATE] = true;
      prototype.routeWheel = function (event: WheelEventInput): void {
        const self = this as AltScreenInstance;
        (self[ANIMATOR] ??= new WheelAnimator()).onWheel(event);
        self.requestRender();
      };
      // Render-driven stepping: each painted frame consumes exactly one eased
      // step, so the glide's pacing matches the real frame rate and slow
      // frames coalesce distance instead of queuing behind a timer.
      prototype.doRender = function (): void {
        const self = this as AltScreenInstance;
        const step = self[ANIMATOR]?.takeStep();
        if (step) {
          // Drive the stock routing (nested scroll views, scrollbar hover,
          // and the requestRender that keeps the glide going) with the eased
          // step size.
          originalRouteWheel.call(
            self,
            { direction: step.direction, x: step.x, y: step.y },
            step.direction * step.magnitude
          );
        }
        originalDoRender.call(self);
      };
    }
  });
}
