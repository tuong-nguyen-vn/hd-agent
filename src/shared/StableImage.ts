import {
  getCapabilities,
  getCellDimensions,
  Image,
} from "@earendil-works/pi-tui";

function cellKey(): string {
  const cell = getCellDimensions();
  return `${cell.widthPx}x${cell.heightPx}`;
}

/**
 * An `Image` whose pixels never change, so it survives the `invalidate()` that
 * cascades down a container on a theme change, a grammar load or a chat
 * rebuild. Re-rendering would call pi-tui's `renderImage` again, which bumps
 * the kitty transmission generation and makes the terminal re-upload the whole
 * base64 payload instead of re-placing an image it already holds.
 *
 * Invalidation is still honoured when it can change the output: when the
 * terminal reports a new cell size (the row count is derived from it), and
 * when there is no image protocol at all, because the text fallback is themed.
 */
export class StableImage extends Image {
  private renderedCellKey: string | undefined;

  public override render(width: number): string[] {
    this.renderedCellKey = cellKey();
    return super.render(width);
  }

  public override invalidate(): void {
    if (getCapabilities().images && this.renderedCellKey === cellKey()) {
      return;
    }
    this.renderedCellKey = undefined;
    super.invalidate();
  }
}
