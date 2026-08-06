import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export type ResolvedModel = {
  readonly model: Model<Api>;
  readonly apiKey: string | undefined;
  readonly headers: Record<string, string | null> | undefined;
};

/**
 * Resolves a model reference into an ordered list of authenticated model
 * candidates, mirroring subagent's fallback semantics. A reference may be a
 * bare model id (matched across all providers, preferring the current
 * provider and authenticated ones) or a `provider/model` pair. Comma-
 * separated references are tried in declared order.
 */
export class ModelResolver {
  public static async resolveCandidates(
    registry: ModelRegistry,
    reference: string,
    currentProvider?: string
  ): Promise<readonly Model<Api>[]> {
    const references = reference
      .split(",")
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0);
    if (references.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    const candidates: Model<Api>[] = [];
    for (const ref of references) {
      for (const model of ModelResolver.resolveReference(
        registry,
        ref,
        currentProvider
      )) {
        const key = `${model.provider}/${model.id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push(model);
      }
    }
    return candidates;
  }

  /**
   * Resolves a single model reference (no commas) into ordered candidates,
   * preferring the current provider and authenticated providers when the
   * reference is a bare model id shared across providers.
   */
  public static resolveReference(
    registry: ModelRegistry,
    reference: string,
    currentProvider?: string
  ): readonly Model<Api>[] {
    const normalized = reference.toLowerCase();
    const models = registry.getAll();

    const canonical = models.filter(
      (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized
    );
    if (canonical.length > 0) {
      return canonical;
    }

    const byId = models.filter(
      (model) => model.id.toLowerCase() === normalized
    );
    if (byId.length === 0) {
      return [];
    }

    const authenticated = byId.filter((model) =>
      registry.hasConfiguredAuth(model)
    );
    const candidates = authenticated.length > 0 ? authenticated : byId;
    return [...candidates].sort((a, b) => {
      const aCurrent = a.provider === currentProvider ? 0 : 1;
      const bCurrent = b.provider === currentProvider ? 0 : 1;
      return aCurrent - bCurrent;
    });
  }

  /**
   * Resolves auth (API key + headers) for a model via the registry, which
   * handles OAuth, env vars, and provider headers — unlike a raw
   * models.json read.
   */
  public static async resolveAuth(
    registry: ModelRegistry,
    model: Model<Api>
  ): Promise<ResolvedModel> {
    const resolution = await registry.getApiKeyAndHeaders(model);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }
    return {
      model,
      apiKey: resolution.apiKey,
      headers: resolution.headers,
    };
  }
}
