import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { Fs } from "./Fs";
import { Paths } from "./Paths";

const Schema = Type.Object({
  tps: Type.Object(
    {
      enabled: Type.Boolean({ default: false }),
    },
    { default: { enabled: false } }
  ),
  powerline: Type.Object(
    {
      enabled: Type.Boolean({ default: true }),
    },
    { default: { enabled: true } }
  ),
  exa: Type.Object(
    {
      apiKey: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  jina: Type.Object(
    {
      apiKey: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  painter: Type.Object(
    {
      // A single model id, "provider/model", or a comma-separated list tried
      // in order as fallbacks (mirrors subagent agent model config).
      model: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  nativeImageGen: Type.Object(
    {
      // When the main model is one of `models`, the proxy's image_generation
      // tool rides along on its chat requests and painter is hidden.
      enabled: Type.Boolean({ default: true }),
      // Comma-separated model ids that accept the tool on /chat/completions.
      models: Type.Optional(Type.String()),
    },
    { default: { enabled: true } }
  ),
  imagePreview: Type.Object(
    {
      // Width of the inline image box in terminal cells; 0 disables inline
      // previews entirely (the terminal shows only the saved path).
      maxWidthCells: Type.Integer({ minimum: 0, default: 60 }),
      // Quantise previews to a 256-colour palette: ~3x fewer bytes to push to
      // the terminal for a photo-like image, at the cost of light dithering.
      palette: Type.Boolean({ default: true }),
    },
    { default: { maxWidthCells: 60, palette: true } }
  ),
  viewMedia: Type.Object(
    {
      // A single model id, "provider/model", or a comma-separated list tried
      // in order as fallbacks (mirrors subagent agent model config).
      model: Type.Optional(Type.String()),
      // Per-model direct-to-model flag, keyed by "provider/id". When true,
      // view_media sends the raw image to the main model instead of calling
      // a dedicated vision model for a text description.
      directToModel: Type.Record(Type.String(), Type.Boolean(), {
        default: {},
      }),
    },
    { default: { directToModel: {} } }
  ),
  readSession: Type.Object(
    {
      // A single model id, "provider/model", or a comma-separated list tried
      // in order as fallbacks (mirrors subagent agent model config).
      model: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  sessionTitle: Type.Object(
    {
      // A single model id, "provider/model", or a comma-separated list tried
      // in order as fallbacks (mirrors subagent agent model config).
      model: Type.Optional(Type.String()),
    },
    { default: {} }
  ),
  // Per-agent model override: a single "model"/"provider/model" reference,
  // or a comma-separated list of references tried in order as fallbacks.
  agents: Type.Record(Type.String(), Type.String(), { default: {} }),
  // Last thinking level explicitly selected per model, keyed by "provider/id".
  thinkingLevels: Type.Record(Type.String(), Type.String(), { default: {} }),
});

type Settings = Static<typeof Schema>;

export class PimSettings {
  private static cache: Settings | undefined;
  private static cachePath: string | undefined;
  private static loadPromise: Promise<Settings> | undefined;
  private static loadPromisePath: string | undefined;
  private static writeQueue: Promise<unknown> = Promise.resolve();

  public static path(): string {
    return join(Paths.pimHomeDir(), "settings.json");
  }

  private static async load(): Promise<Settings> {
    const path = PimSettings.path();
    if (PimSettings.cache !== undefined && PimSettings.cachePath === path) {
      return PimSettings.cache;
    }
    if (PimSettings.loadPromisePath !== path) {
      PimSettings.loadPromise = undefined;
      PimSettings.loadPromisePath = path;
    }
    PimSettings.loadPromise ??= (async () => {
      let raw: unknown;
      try {
        raw = await Bun.file(path).json();
      } catch {
        raw = {};
      }
      const filled = Value.Default(Schema, raw);
      const settings: Settings = Value.Check(Schema, filled)
        ? filled
        : Value.Create(Schema);
      PimSettings.cache = settings;
      PimSettings.cachePath = path;
      return settings;
    })();
    return PimSettings.loadPromise;
  }

  private static async ensureHomeDir(): Promise<void> {
    const dir = Paths.pimHomeDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }

  public static async getExaApiKey(): Promise<string | undefined> {
    return (
      PimSettings.normalize(process.env["EXA_API_KEY"]) ??
      PimSettings.normalize((await PimSettings.get("exa")).apiKey)
    );
  }

  public static async getJinaApiKey(): Promise<string | undefined> {
    return (
      PimSettings.normalize(process.env["JINA_API_KEY"]) ??
      PimSettings.normalize((await PimSettings.get("jina")).apiKey)
    );
  }

  public static async getPainterModel(): Promise<string> {
    return (
      PimSettings.normalize((await PimSettings.get("painter")).model) ??
      "gpt-6-luna"
    );
  }

  public static async getNativeImageGenEnabled(): Promise<boolean> {
    return (await PimSettings.get("nativeImageGen")).enabled;
  }

  /** Model ids allowed to paint natively; `gpt-6-luna` unless overridden. */
  public static async getNativeImageGenModels(): Promise<readonly string[]> {
    const raw =
      PimSettings.normalize((await PimSettings.get("nativeImageGen")).models) ??
      "gpt-6-luna";
    return raw
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0);
  }

  public static async getImagePreview(): Promise<{
    readonly maxWidthCells: number;
    readonly palette: boolean;
  }> {
    return PimSettings.get("imagePreview");
  }

  public static async getViewMediaModel(): Promise<string> {
    return (
      PimSettings.normalize((await PimSettings.get("viewMedia")).model) ??
      "gemini-3.8-flash"
    );
  }

  public static async getViewMediaDirectToModel(
    modelKey: string
  ): Promise<boolean> {
    const map = (await PimSettings.get("viewMedia")).directToModel;
    return map[modelKey] ?? false;
  }

  public static async getReadSessionModel(): Promise<string> {
    return (
      PimSettings.normalize((await PimSettings.get("readSession")).model) ??
      "gemini-3.8-flash"
    );
  }

  public static async getSessionTitleModel(): Promise<string> {
    return (
      PimSettings.normalize((await PimSettings.get("sessionTitle")).model) ??
      "gemini-3.8-flash,claude-haiku-4-5-20251001"
    );
  }

  public static async getAgentModel(
    agentName: string
  ): Promise<string | undefined> {
    const agents = await PimSettings.get("agents");
    return PimSettings.normalize(agents[agentName]);
  }

  public static async getThinkingLevels(): Promise<Record<string, string>> {
    return PimSettings.get("thinkingLevels");
  }

  public static async setThinkingLevel(
    modelKey: string,
    level: string
  ): Promise<void> {
    const current = await PimSettings.get("thinkingLevels");
    await PimSettings.set("thinkingLevels", { ...current, [modelKey]: level });
  }

  private static normalize(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  }

  static async get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    return (await PimSettings.load())[key];
  }

  static async set<K extends keyof Settings>(
    key: K,
    value: Settings[K]
  ): Promise<void> {
    const task = async (): Promise<void> => {
      const current = await PimSettings.load();
      const next: Settings = { ...current, [key]: value };
      if (!Value.Check(Schema, next)) {
        throw new Error(`Invalid value for pim setting "${String(key)}"`);
      }
      const path = PimSettings.path();
      PimSettings.cache = next;
      PimSettings.cachePath = path;
      await PimSettings.ensureHomeDir();
      await Fs.writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    };
    PimSettings.writeQueue = PimSettings.writeQueue.then(task, task);
    await PimSettings.writeQueue;
  }
}
