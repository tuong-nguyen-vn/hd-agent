const MAX_ENTRIES = 64;

/**
 * Per pi session, remembers what painter needs to continue a series: the last
 * `/responses` id per model (chained via `previous_response_id`, which keeps
 * the text context and the prompt cache warm) and the last image file
 * (re-attached on edits — the image tool only sees images in the current
 * request, so the chain alone does not keep pictures consistent).
 */
export class ResponseChain {
  private readonly ids = new Map<string, string>();
  private readonly images = new Map<string, string>();
  private readonly unsupported = new Set<string>();

  public get(sessionId: string, modelKey: string): string | undefined {
    return this.ids.get(ResponseChain.key(sessionId, modelKey));
  }

  public set(
    sessionId: string,
    modelKey: string,
    responseId: string | undefined
  ): void {
    ResponseChain.put(
      this.ids,
      ResponseChain.key(sessionId, modelKey),
      responseId
    );
  }

  public clear(sessionId: string, modelKey: string): void {
    this.ids.delete(ResponseChain.key(sessionId, modelKey));
  }

  public lastImage(sessionId: string): string | undefined {
    return this.images.get(sessionId);
  }

  public setImage(sessionId: string, path: string | undefined): void {
    ResponseChain.put(this.images, sessionId, path);
  }

  /** Marks a model as rejecting `previous_response_id` so we stop sending it. */
  public markUnsupported(modelKey: string): void {
    this.unsupported.add(modelKey);
  }

  public supports(modelKey: string): boolean {
    return !this.unsupported.has(modelKey);
  }

  private static key(sessionId: string, modelKey: string): string {
    return `${sessionId} ${modelKey}`;
  }

  /** Insert-or-refresh with oldest-first eviction. */
  private static put(
    map: Map<string, string>,
    key: string,
    value: string | undefined
  ): void {
    map.delete(key);
    if (!value) {
      return;
    }
    map.set(key, value);
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next();
      if (oldest.done) {
        break;
      }
      map.delete(oldest.value);
    }
  }
}
