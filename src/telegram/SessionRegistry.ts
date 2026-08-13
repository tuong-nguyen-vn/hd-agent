import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Fs } from "../shared/Fs";
import { type TelegramConfig } from "./Config";
import { Session, type SessionId, type SessionSettings } from "./Session";
import type { TaskScheduler } from "./TaskScheduler";

const LRU_CAP = 16;
// Settings are patched on every turn (cumulative cost) and on each
// cwd/model/level change; coalesce those into one state.json rewrite.
const SETTINGS_FLUSH_DEBOUNCE_MS = 1_000;

export class SessionRegistry {
  private readonly config: TelegramConfig;
  private readonly api: Api;
  private readonly scheduler: TaskScheduler;
  private readonly cache = new Map<string, Session>();
  private modelRuntime!: ModelRuntime;
  private modelRegistry!: ModelRegistry;
  private readonly settingsManagers = new Map<string, SettingsManager>();
  private readonly agentDir: string;
  private settings: Map<string, SessionSettings> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private botUsername: string | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushDirty = false;
  private flushChain: Promise<void> = Promise.resolve();

  public constructor(
    config: TelegramConfig,
    api: Api,
    scheduler: TaskScheduler
  ) {
    this.config = config;
    this.api = api;
    this.scheduler = scheduler;
    this.agentDir = getAgentDir();
  }

  public setBotUsername(username: string): void {
    this.botUsername = username;
  }

  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initPromise ??= this.bootstrap().catch((err: unknown) => {
      this.initPromise = undefined;
      throw err;
    });
    await this.initPromise;
  }

  public get(sessionId: SessionId): Session {
    this.requireInitialized();
    const key = Session.encodeId(sessionId);
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }
    this.evictIfNeeded();
    const session = new Session({
      id: sessionId,
      settings: this.settings.get(key) ?? {},
      config: this.config,
      api: this.api,
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      modelRegistry: this.modelRegistry,
      scheduler: this.scheduler,
      settingsManagerFor: (cwd) => this.settingsManagerFor(cwd),
      persistSettings: (patch, opts) => this.persistSettings(key, patch, opts),
      getBotUsername: () => this.botUsername,
    });
    this.cache.set(key, session);
    return session;
  }

  public async disposeAll(): Promise<void> {
    for (const session of this.cache.values()) {
      session.dispose();
    }
    this.cache.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.initialized) {
      this.flushDirty = true;
      await this.flushSettings();
    }
  }

  private async bootstrap(): Promise<void> {
    this.modelRuntime = await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });
    this.modelRegistry = new ModelRegistry(this.modelRuntime);
    const loaded = await Fs.readJsonOrEmpty<Record<string, SessionSettings>>(
      join(this.config.configDir, "state.json"),
      {}
    );
    this.settings = new Map(Object.entries(loaded));
    await mkdir(join(this.config.configDir, "sessions"), { recursive: true });
    await mkdir(join(this.config.configDir, "isolated-sessions"), {
      recursive: true,
    });
    await mkdir(join(this.config.configDir, "instructions"), {
      recursive: true,
    });
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("SessionRegistry.init() must complete before use");
    }
  }

  private async persistSettings(
    key: string,
    patch: Partial<SessionSettings>,
    opts?: { readonly coalesce?: boolean }
  ): Promise<void> {
    const prev = this.settings.get(key) ?? {};
    this.settings.set(key, { ...prev, ...patch });
    this.flushDirty = true;
    if (!opts?.coalesce) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      await this.flushSettings();
      return;
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushSettings();
    }, SETTINGS_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  // Serialized through flushChain so overlapping flushes cannot interleave
  // their atomic renames out of order.
  private flushSettings(): Promise<void> {
    this.flushChain = this.flushChain.then(async () => {
      if (!this.flushDirty) {
        return;
      }
      this.flushDirty = false;
      try {
        await Fs.writeAtomic(
          join(this.config.configDir, "state.json"),
          JSON.stringify(Object.fromEntries(this.settings), null, 2)
        );
      } catch (err) {
        console.warn(`[registry] state save failed:`, err);
      }
    });
    return this.flushChain;
  }

  private settingsManagerFor(cwd: string): SettingsManager {
    const existing = this.settingsManagers.get(cwd);
    if (existing) {
      return existing;
    }
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    this.settingsManagers.set(cwd, settingsManager);
    return settingsManager;
  }

  private evictIfNeeded(): void {
    if (this.cache.size < LRU_CAP) {
      return;
    }
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.cache) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) {
      return;
    }
    const entry = this.cache.get(oldestKey)!;
    entry.dispose();
    this.cache.delete(oldestKey);
  }
}
