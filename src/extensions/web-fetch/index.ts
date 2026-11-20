import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";
import {
  Renderer,
  type StatefulToolCallTitleContext,
  type StatefulToolCallTitleState,
} from "../../shared/Renderer";
import { SpillCache } from "../../shared/SpillCache";
import { Tools } from "../../shared/Tools";
import { executeFetch, validatePublicUrl, type WebFetchOutcome } from "./fetch";
import { JinaReaderClient } from "./JinaReaderClient";
import {
  renderTitle as formatRenderedTitle,
  type WebFetchTitleOutcome,
} from "./render";
import { type WebFetchInput, webFetchSchema } from "./schema";
import { WebViewFetchClient } from "./WebViewFetchClient";

const PREVIEW_LINES = 10;

type WebFetchRenderState = StatefulToolCallTitleState & {
  outcome?: WebFetchTitleOutcome;
};

type WebFetchRenderContext = StatefulToolCallTitleContext & {
  readonly args?: Partial<WebFetchInput>;
};

function renderTitle(
  input: Partial<WebFetchInput>,
  theme: Theme,
  context: WebFetchRenderContext
) {
  const state = context.state as WebFetchRenderState;
  const markerColor = Renderer.markerColorFor(
    Boolean(context.isPartial),
    Boolean(context.isError)
  );
  return Renderer.renderStatefulToolCallTitle({
    label: "Web Fetch",
    title: formatRenderedTitle(input.url, input.format, state.outcome, (text) =>
      theme.fg("muted", text)
    ),
    theme,
    context,
    markerGlyph: Renderer.markerGlyphFor(markerColor),
    separator: " ",
    useSpinner: true,
  });
}

async function createJina(): Promise<JinaReaderClient> {
  const apiKey = await PimSettings.getJinaApiKey();
  return new JinaReaderClient(apiKey ? { apiKey } : {});
}

export default function (pi: ExtensionAPI): void {
  SpillCache.installSweeper();

  let jinaPromise: Promise<JinaReaderClient> | undefined;
  const getJina = () => (jinaPromise ??= createJina());
  const webView = new WebViewFetchClient();

  Tools.register(pi, {
    name: "web_fetch",
    label: "web_fetch",
    description: "Fetch a web page as markdown or HTML.",
    parameters: webFetchSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_id, params, signal) {
      const { url, format } = params as WebFetchInput;

      if (signal?.aborted) {
        throw new Error("Web fetch aborted before execution.");
      }

      const safeUrl = validatePublicUrl(url);

      const jina = await getJina();
      const outcome = await executeFetch({
        jina,
        webView,
        url: safeUrl,
        format: format ?? "markdown",
        ...(signal === undefined ? {} : { signal }),
      });

      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          url: outcome.url,
          title: outcome.title,
          format: outcome.format,
          returnedBytes: outcome.returnedBytes,
          totalBytes: outcome.totalBytes,
          truncated: outcome.truncated,
          path: outcome.path,
        },
      };
    },
    renderCall(args, theme, context) {
      return renderTitle(
        (args ?? {}) as Partial<WebFetchInput>,
        theme,
        context
      );
    },
    renderResult(result, options, theme, context) {
      const state = context.state as WebFetchRenderState;

      if (!options.isPartial && state.outcome === undefined) {
        const details = result.details as
          Pick<WebFetchOutcome, "format" | "totalBytes"> | undefined;

        if (
          details?.format !== undefined &&
          typeof details.totalBytes === "number"
        ) {
          state.outcome = {
            format: details.format,
            totalBytes: details.totalBytes,
          };
        }
      }

      renderTitle(context.args ?? {}, theme, context);

      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: PREVIEW_LINES,
      });
    },
  });
}
