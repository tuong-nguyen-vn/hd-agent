import { type Static, Type } from "typebox";

export const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Absolute or relative path to file (resolved against cwd).",
    }),
    edits: Type.Array(
      Type.Object(
        {
          oldString: Type.String({
            description:
              "Use the actual file content without the `LINE:` prefix from read output. Must be unique unless replaceAll=true. Include enough surrounding context for uniqueness.",
          }),
          newString: Type.String({
            description:
              "Replacement text. Empty string deletes the matched range.",
          }),
          // Nullable-but-required (not `Type.Optional`): strict-mode JSON
          // Schema requires every property in `required`; pass `null` to omit.
          replaceAll: Type.Union([
            Type.Boolean({
              description:
                "If true, replaces every occurrence of oldString. Defaults to false.",
            }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false }
      ),
      {
        minItems: 1,
        description:
          "Non-empty atomic batch of edits, even for a single change — wrap it as `edits: [{ oldString, newString }]`, not top-level `oldString`/`newString` fields. " +
          "Batched edits resolve against the initial file state and must not overlap. For sequential transformations where edit 2 depends on edit 1's result, use separate tool calls.",
      }
    ),
  },
  { additionalProperties: false }
);

export type EditInput = Static<typeof editSchema>;

// Hand-declared rather than derived from `EditInput["edits"][number]`: the
// wire schema makes `replaceAll` required-but-nullable for strict-mode JSON
// Schema compliance, but internal callers (and tests) should still be able
// to omit it, matching the `raw.replaceAll ?? false` default below.
export type RawEdit = {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean | null;
};
