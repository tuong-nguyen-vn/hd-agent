import { describe, expect, it } from "bun:test";
import { getOpencodeFreeModels } from "./opencode-free";

describe("opencode-free", () => {
  it("returns a static free-model list without network", () => {
    const models = getOpencodeFreeModels();
    expect(models.length).toBe(0);
  });
});
