import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";
import registerViewMedia from "./index";

type CommandHandler = (args: string | undefined, ctx: unknown) => Promise<void>;

type MockPi = {
  readonly api: ExtensionAPI;
  readonly commands: Map<string, CommandHandler>;
};

function createPi(): MockPi {
  const commands = new Map<string, CommandHandler>();
  const api = {
    registerCommand(name: string, def: { handler: CommandHandler }): void {
      commands.set(name, def.handler);
    },
    registerTool(): void {},
    on(): void {},
  } as unknown as ExtensionAPI;
  return { api, commands };
}

function makeCtx(
  model: unknown,
  notifications: { type: string; message: string }[]
) {
  return {
    model,
    ui: {
      notify(message: string, type: string): void {
        notifications.push({ type, message });
      },
    },
  };
}

const imageModel = {
  id: "gpt-4o",
  provider: "openai",
  input: ["text", "image"],
};
const textOnlyModel = { id: "gpt-3.5", provider: "openai", input: ["text"] };

const originalGet = PimSettings.get;
const originalSet = PimSettings.set;

describe("/vision-direct command", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createPi();
    registerViewMedia(pi.api);
  });

  afterEach(() => {
    Object.defineProperty(PimSettings, "get", { value: originalGet });
    Object.defineProperty(PimSettings, "set", { value: originalSet });
  });

  function mockSettings(directToModel: boolean) {
    Object.defineProperty(PimSettings, "getViewMediaDirectToModel", {
      value: async () => directToModel,
      configurable: true,
    });
    Object.defineProperty(PimSettings, "get", {
      value: async () => ({
        model: undefined,
        directToModel: directToModel ? { "openai/gpt-4o": true } : {},
      }),
      configurable: true,
    });
    Object.defineProperty(PimSettings, "set", {
      value: async () => {},
      configurable: true,
    });
  }

  test("toggle false→true with image-capable model", async () => {
    mockSettings(false);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler(undefined, makeCtx(imageModel, notifications));
    expect(notifications).toEqual([
      {
        type: "info",
        message: "Direct-to-model: ON",
      },
    ]);
  });

  test("toggle false→true blocked when model lacks image input", async () => {
    mockSettings(false);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler(undefined, makeCtx(textOnlyModel, notifications));
    expect(notifications).toEqual([
      {
        type: "error",
        message:
          "Cannot enable direct-to-model: current model does not support image input",
      },
    ]);
  });

  test("toggle true→false always allowed", async () => {
    mockSettings(true);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler(undefined, makeCtx(textOnlyModel, notifications));
    expect(notifications).toEqual([
      {
        type: "info",
        message: "Direct-to-model: OFF",
      },
    ]);
  });

  test("explicit true with image model", async () => {
    mockSettings(false);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler("true", makeCtx(imageModel, notifications));
    expect(notifications).toEqual([
      {
        type: "info",
        message: "Direct-to-model: ON",
      },
    ]);
  });

  test("explicit false always allowed", async () => {
    mockSettings(true);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler("false", makeCtx(textOnlyModel, notifications));
    expect(notifications).toEqual([
      {
        type: "info",
        message: "Direct-to-model: OFF",
      },
    ]);
  });

  test("explicit true blocked when model lacks image input", async () => {
    mockSettings(false);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler("true", makeCtx(textOnlyModel, notifications));
    expect(notifications).toEqual([
      {
        type: "error",
        message:
          "Cannot enable direct-to-model: current model does not support image input",
      },
    ]);
  });

  test("invalid argument shows usage", async () => {
    mockSettings(false);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler("yes", makeCtx(imageModel, notifications));
    expect(notifications).toEqual([
      { type: "error", message: "Usage: /vision-direct [true|false]" },
    ]);
  });

  test("toggle true→false with image model", async () => {
    mockSettings(true);
    const notifications: { type: string; message: string }[] = [];
    const handler = pi.commands.get("vision-direct")!;
    await handler(undefined, makeCtx(imageModel, notifications));
    expect(notifications).toEqual([
      {
        type: "info",
        message: "Direct-to-model: OFF",
      },
    ]);
  });
});
