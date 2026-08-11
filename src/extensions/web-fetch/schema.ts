import { type Static, type TUnsafe, Type } from "typebox";

export const WEB_FETCH_INLINE_BYTES = 32 * 1024;

export const FETCH_FORMATS = ["markdown", "html"] as const;
export type WebFetchFormat = (typeof FETCH_FORMATS)[number];
export type WebFetchResolvedFormat = WebFetchFormat;

// Inlined from @earendil-works/pi-ai's StringEnum to avoid importing
// pi-ai at module load time — web-fetch is the first extension to import
// pi-ai values, which triggers loading a second copy of the package from
// hd-agent's own node_modules (~300-400ms).
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] }
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values as unknown as string[],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

export const webFetchSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description: "Must be a public http(s) URL.",
  }),
  format: Type.Optional(
    StringEnum(FETCH_FORMATS, {
      description:
        "`markdown`: used by default. `html`: use only when raw source is required.",
    })
  ),
});

export type WebFetchInput = Static<typeof webFetchSchema>;
