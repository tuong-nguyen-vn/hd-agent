import { describe, expect, test } from "bun:test";

describe("rpiv-ask-user-question extension entry", () => {
  test("registers ask_user_question tool via a minimal pi stub", async () => {
    const spec = "@juicesharp/rpiv-ask-user-question" as string;
    const mod = await import(spec);
    const registered: string[] = [];
    const noop = () => {};
    const pi: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "registerTool") {
            return (def: any) => registered.push(def.name);
          }
          return noop;
        },
      }
    );
    expect(typeof mod.default).toBe("function");
    let threw: unknown = null;
    try {
      await mod.default(pi);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    expect(registered).toContain("ask_user_question");
  });
});
