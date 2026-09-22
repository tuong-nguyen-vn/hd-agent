import { afterEach, expect, test } from "bun:test";
import {
  resetCapabilitiesCache,
  setCapabilities,
  setCellDimensions,
} from "@earendil-works/pi-tui";
import { StableImage } from "./StableImage";

// 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function image(): StableImage {
  return new StableImage(PNG, "image/png", {
    fallbackColor: (text: string) => text,
  });
}

afterEach(() => {
  resetCapabilitiesCache();
  setCellDimensions({ widthPx: 9, heightPx: 18 });
});

test("keeps its rendered lines across an invalidate", () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const component = image();
  const first = component.render(80);

  component.invalidate();

  expect(component.render(80)).toBe(first);
});

test("re-renders when the terminal reports a new cell size", () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const component = image();
  const first = component.render(80);

  setCellDimensions({ widthPx: 12, heightPx: 26 });
  component.invalidate();

  expect(component.render(80)).not.toBe(first);
});

test("re-renders the themed fallback when there is no image protocol", () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const component = image();
  const first = component.render(80);

  component.invalidate();

  const second = component.render(80);
  expect(second).not.toBe(first);
  expect(second).toEqual(first);
});
