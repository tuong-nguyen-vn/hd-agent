import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  buildContextLines,
  colorFor,
  fetchHdwebsoftUsage,
  renderUsageReport,
} from "./hdwebsoft-usage";

export const HDWEBSOFT_PROXY_ROOT = "https://proxy-api.hdwebsoft.co";
const PROVIDER_ID = "hdwebsoft-proxy";
const USAGE_WIDGET_ID = "usage-report";

let usageWidgetShown = false;

function showUsageWidget(
  ctx: ExtensionContext,
  lines: readonly string[]
): void {
  if (ctx.hasUI) {
    // Component factory (not a string array) so pi's 10-line widget cap
    // doesn't truncate the report.
    ctx.ui.setWidget(USAGE_WIDGET_ID, () => new Text(lines.join("\n"), 1, 0));
    usageWidgetShown = true;
  } else {
    console.log(lines.join("\n"));
  }
}

function startUsageSpinner(
  ctx: ExtensionContext
): ReturnType<typeof setInterval> {
  const frames = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
  let i = 0;
  const render = (): void => {
    i = (i + 1) % frames.length;
    ctx.ui.setWidget(USAGE_WIDGET_ID, [
      ctx.ui.theme.fg("accent", frames[i]!) +
        " " +
        ctx.ui.theme.fg("muted", "fetching usage…"),
    ]);
  };
  render();
  return setInterval(render, 80);
}

export function registerHdwebsoftProxy(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "HDWEBSOFT Proxy",
    authHeader: true,
    models: [
      {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        api: "google-generative-ai",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1beta`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
        thinkingLevelMap: { off: null, minimal: null },
      },
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        api: "google-generative-ai",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1beta`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
        thinkingLevelMap: { off: null, minimal: null },
      },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        api: "google-generative-ai",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1beta`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "LOW",
          medium: null,
          high: "HIGH",
        },
      },
      {
        id: "gemini-3.1-flash-image",
        name: "Gemini Nano Banana 2",
        api: "google-generative-ai",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1beta`,
        reasoning: false,
        input: ["image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        api: "openai-completions",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 272000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "mimo-v2.5",
        name: "MiMo v2.5",
        api: "openai-completions",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "glm-5-2",
        name: "GLM 5.2",
        api: "openai-completions",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 131072,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "glm-5-3",
        name: "GLM 5.3",
        api: "openai-completions",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 131072,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "glm-5-3-flash",
        name: "GLM 5.3 Flash",
        api: "openai-completions",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0.14, output: 0.44, cacheRead: 0.026, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 131072,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: null,
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        api: "openai-completions",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 200000,
        maxTokens: 131072,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });

  pi.registerCommand("usage-hdwebsoft", {
    description: "Show HDWEBSOFT proxy quota",
    handler: async (_args, ctx) => {
      const color = colorFor(ctx);
      const model = ctx.model;
      if (!model || model.provider !== PROVIDER_ID) {
        showUsageWidget(ctx, [
          color("error", "✗ ") + color("title", "usage-hdwebsoft"),
          color(
            "muted",
            "Available only for hdwebsoft-proxy models — /model to switch"
          ),
        ]);
        return;
      }
      const spinner = ctx.hasUI ? startUsageSpinner(ctx) : undefined;
      const lines: string[] = [
        color("ok", "✓ ") + color("title", "usage-hdwebsoft"),
      ];
      lines.push(...buildContextLines(ctx, color));
      lines.push("");
      try {
        const resolution = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!resolution.ok || !resolution.apiKey) {
          throw new Error(
            `No API key for ${PROVIDER_ID} — run /login ${PROVIDER_ID}`
          );
        }
        lines.push(
          ...renderUsageReport(
            await fetchHdwebsoftUsage(HDWEBSOFT_PROXY_ROOT, resolution.apiKey),
            color
          )
        );
      } catch (err) {
        lines[0] = color("error", "✗ ") + color("title", "usage-hdwebsoft");
        lines.push(
          color("error", `usage fetch failed: ${(err as Error).message}`)
        );
      }
      if (spinner) {
        clearInterval(spinner);
      }
      showUsageWidget(ctx, lines);
    },
  });

  pi.on("input", (_event, ctx) => {
    if (usageWidgetShown) {
      ctx.ui.setWidget(USAGE_WIDGET_ID, undefined);
      usageWidgetShown = false;
    }
    return { action: "continue" };
  });
}
