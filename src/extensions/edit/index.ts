import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DiffRenderState, DiffView } from "../../shared/DiffView";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { editFile, formatEditSummary } from "./edit";
import { type EditInput, editSchema } from "./schema";

const ERROR_PREVIEW_LINES = 12;
const DIFF_PREVIEW_LINES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Models occasionally emit a single edit flattened at the top level
 * (`{path, oldString, newString, replaceAll}`), mirroring the common
 * old_str/new_str convention from other editing tools instead of this
 * tool's batched `edits: [...]` array. Rewrap that shape before validation
 * instead of rejecting it outright.
 */
function normalizeFlatEdit(rawArgs: unknown): EditInput {
  if (!isRecord(rawArgs) || "edits" in rawArgs) {
    return rawArgs as EditInput;
  }
  const { path, oldString, newString, replaceAll, ...rest } = rawArgs;
  if (oldString === undefined && newString === undefined) {
    return rawArgs as EditInput;
  }
  return {
    path,
    edits: [{ oldString, newString, replaceAll }],
    ...rest,
  } as EditInput;
}

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "edit",
    label: "edit",
    description:
      "Replace strings in a UTF-8 text file. " +
      "Prefer edit over write for changes to existing files.",
    parameters: editSchema,
    renderShell: "self",
    executionMode: "sequential",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: normalizeFlatEdit,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, edits } = params as EditInput;

      if (signal?.aborted) {
        throw new Error("Edit aborted before execution.");
      }

      const absolutePath = Paths.resolve(path, ctx.cwd);
      const outcome = await editFile(absolutePath, edits);

      return {
        content: [{ type: "text", text: formatEditSummary(path, outcome) }],
        details: outcome,
      };
    },
    renderCall(args, theme, context) {
      const rawPath = typeof args?.path === "string" ? args.path : undefined;
      return DiffView.renderDiffCall({
        label: "Edit",
        rawPath,
        theme,
        context: context as typeof context & { state: DiffRenderState },
        separator: " ",
        markerGlyph: Renderer.markerGlyphFor,
        link: true,
        clickableLink: true,
        padTitle: false,
      });
    },
    renderResult(result, options, theme, context) {
      return DiffView.renderDiffResult({
        label: "Edit",
        result,
        options,
        theme,
        context: context as typeof context & { state: DiffRenderState },
        previewLines: ERROR_PREVIEW_LINES,
        diffPreviewLines: DIFF_PREVIEW_LINES,
        separator: " ",
        markerGlyph: Renderer.markerGlyphFor,
      });
    },
  });
}
