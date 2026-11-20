import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { validateToolArguments as ValidateFn } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Levenshtein } from "./Levenshtein";

// Lazy-loaded on first call (not fired at module load) to avoid triggering
// a background import of pi-ai that competes for CPU during startup.
// Kick-start the import immediately so it resolves in parallel with the
// rest of startup; Tools.ready is awaited in _init's session_start to
// guarantee completion before the first tool call.
let cachedValidate: typeof ValidateFn | undefined;
let validatePromise: Promise<void> | undefined;

function ensureValidate(): void {
  if (!cachedValidate && !validatePromise) {
    validatePromise = import("@earendil-works/pi-ai").then((mod) => {
      cachedValidate = mod.validateToolArguments as typeof ValidateFn;
    });
  }
}

// Start the import as soon as Tools.ts is loaded (during extension
// registration, before the agent loop begins).
ensureValidate();

function validateToolArguments(
  ...args: Parameters<typeof ValidateFn>
): ReturnType<typeof ValidateFn> {
  ensureValidate();
  if (!cachedValidate) {
    throw new Error(
      "Tools.validateToolArguments called before pi-ai finished loading"
    );
  }
  return cachedValidate(...args);
}

type Issue = {
  readonly path: string;
  readonly message: string;
  readonly missingProps?: readonly string[];
};

// JSON Schema validation keywords that some providers (notably Anthropic)
// reject in tool input schemas. Stripping them from the wire schema keeps
// the constraints available for local validation (prepareArguments) while
// avoiding 400 errors from strict providers.
const UNSUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

// Keywords whose keys are author-chosen names rather than JSON Schema
// keywords. Their values are schemas, but the keys must never be matched
// against UNSUPPORTED_SCHEMA_KEYWORDS — a tool with a property literally
// named `pattern` (grep, glob) would otherwise lose that property.
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "definitions",
  "$defs",
]);

// Keywords whose values are plain data, not schemas. Recursing into them
// would strip keys out of a const/default/example object.
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "enum",
  "const",
  "default",
  "examples",
  "required",
]);

function stripUnsupportedSchemaKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(stripUnsupportedSchemaKeywords);
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    const value = (schema as Record<string, unknown>)[key];
    if (DATA_KEYWORDS.has(key)) {
      result[key] = value;
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && value !== null && isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        mapped[name] = stripUnsupportedSchemaKeywords(value[name]);
      }
      result[key] = mapped;
      continue;
    }
    result[key] = stripUnsupportedSchemaKeywords(value);
  }
  return result;
}

type JsonSchema = {
  readonly type?: string;
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema | readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly enum?: readonly unknown[];
};

export class Tools {
  /** Resolves when the lazy pi-ai import has completed. */
  static get ready(): Promise<void> {
    ensureValidate();
    return validatePromise ?? Promise.resolve();
  }

  /**
   * Wrap a tool definition so pi's validator errors get rewritten before they
   * reach the model. Pi runs `prepareArguments` before validation, so we call
   * pi's validator ourselves inside it, rewrite any throw, and return the
   * (coerced) args; pi's own second validation pass then sees clean input.
   * After successful validation we also reject unknown top-level keys, since
   * TypeBox object schemas accept them by default and typos like
   * `headlimit` vs `head_limit` would silently no-op.
   *
   * Use `Tools.register` for `pi.registerTool` callers; use `Tools.wrap` to
   * pass into `customTools`.
   */
  static wrap<TParams extends TSchema, TDetails = unknown, TState = unknown>(
    def: ToolDefinition<TParams, TDetails, TState>
  ): ToolDefinition<TParams, TDetails, TState> {
    const schema = def.parameters as unknown as JsonSchema;
    return {
      ...def,
      parameters: stripUnsupportedSchemaKeywords(def.parameters) as TParams,
      prepareArguments: (rawArgs: unknown): Static<TParams> => {
        const prepared = def.prepareArguments
          ? def.prepareArguments(rawArgs)
          : (rawArgs as Static<TParams>);
        const coerced = coerceQuotedEnums(prepared, schema);
        const cleaned = backfillNullableDefaults(
          coerced,
          schema
        ) as Static<TParams>;
        const strictIssues = checkStrictTypes(cleaned, schema, "");
        if (strictIssues.length > 0) {
          const lines = strictIssues.map((s) => `  - ${s}`).join("\n");
          throw new Error(
            `Validation failed for tool "${def.name}":\n${lines}`
          );
        }
        // Check for unknown top-level keys before running the schema
        // validator: when a tool's schema sets `additionalProperties: false`
        // (required for strict-mode function calling), the validator would
        // otherwise reject typos like `headlimit` with a generic "must not
        // have additional properties" error instead of this friendlier,
        // typo-aware one.
        const unknownKeys = findUnknownTopLevelKeys(schema, cleaned);
        if (unknownKeys.length > 0) {
          throw new Error(
            formatUnknownKeysError(def.name, schema, unknownKeys)
          );
        }
        let validated: Static<TParams>;
        try {
          validated = validateToolArguments(
            { name: def.name, parameters: def.parameters } as never,
            {
              type: "toolCall",
              id: "",
              name: def.name,
              arguments: cleaned as JsonObject,
            }
          ) as Static<TParams>;
        } catch (err) {
          throw new Error(
            Tools.rewriteValidationError(def.name, schema, err, cleaned)
          );
        }
        return validated;
      },
    };
  }

  static register<
    TParams extends TSchema,
    TDetails = unknown,
    TState = unknown,
  >(pi: ExtensionAPI, def: ToolDefinition<TParams, TDetails, TState>): void {
    pi.registerTool(Tools.wrap(def));
  }

  /**
   * Rewrite a `validateToolArguments` error string into a clearer form.
   * `schema` is the tool's parameters schema, used to enumerate allowed values
   * for `anyOf`/`enum` failures. `args` is the validated input, used to pick
   * the matching branch of a discriminated union. Public for testing.
   */
  static rewriteValidationError(
    toolName: string,
    schema: JsonSchema,
    err: unknown,
    _args?: unknown
  ): string {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Validation failed for tool")) {
      return message;
    }

    const raw = parseIssues(message);
    const grouped = groupMissingIssues(raw);
    const issues = grouped.map((issue) => formatIssue(issue, schema));

    const header = `Validation failed for tool "${toolName}":`;
    if (issues.length === 0) {
      return header;
    }
    return `${header}\n${issues.map((s) => `  - ${s}`).join("\n")}`;
  }
}

function parseIssues(message: string): Issue[] {
  const issues: Issue[] = [];
  for (const line of message.split("\n")) {
    if (line.startsWith("Received arguments:")) {
      break;
    }
    if (!line.startsWith("  - ")) {
      continue;
    }
    const body = line.slice(4);
    const colonIdx = body.indexOf(": ");
    if (colonIdx === -1) {
      issues.push({ path: "", message: body });
    } else {
      issues.push({
        path: body.slice(0, colonIdx),
        message: body.slice(colonIdx + 2),
      });
    }
  }
  return issues;
}

/**
 * The validator reports each missing property as `<path>: missing`. Group
 * properties that share a parent object into one `missing required
 * propert(y|ies)` line so a schema requiring several fields produces a single
 * actionable message instead of one line per field.
 */
function groupMissingIssues(issues: readonly Issue[]): Issue[] {
  const groups = new Map<string, { index: number; props: string[] }>();
  const result: Issue[] = [];
  for (const issue of issues) {
    if (issue.message !== "missing") {
      result.push(issue);
      continue;
    }
    const dot = issue.path.lastIndexOf(".");
    const parent = dot === -1 ? "" : issue.path.slice(0, dot);
    const prop = dot === -1 ? issue.path : issue.path.slice(dot + 1);
    const group = groups.get(parent);
    if (group) {
      group.props.push(prop);
      continue;
    }
    groups.set(parent, { index: result.length, props: [prop] });
    result.push({ path: parent, message: "missing", missingProps: [prop] });
  }
  for (const [, group] of groups) {
    const issue = result[group.index]!;
    result[group.index] = { ...issue, missingProps: group.props };
  }
  return result;
}

function describeAnyOf(branches: readonly JsonSchema[]): string {
  const constValues = branches
    .map((b) => (b && "const" in b ? b.const : undefined))
    .filter((v) => v !== undefined);
  if (constValues.length === branches.length) {
    return `must be one of: ${constValues.map(displayValue).join(", ")}`;
  }

  const discriminator = findDiscriminator(branches);
  if (discriminator) {
    const values = discriminator.values.map(displayValue).join(", ");
    return `must match one of the allowed variants (${discriminator.field}: ${values})`;
  }

  return `must match one of ${branches.length} allowed variants`;
}

/**
 * Format an enum value for an error message. Strings render bare so a weaker
 * model that retries off the message doesn't include the quotes in its next
 * attempt (e.g. `action: "\"create\""`). Non-strings keep JSON form for
 * disambiguation.
 */
function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function matchDiscriminatedBranch(
  branches: readonly JsonSchema[],
  value: unknown
): JsonSchema | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const discriminator = findDiscriminator(branches);
  if (!discriminator) {
    return undefined;
  }
  const actual = value[discriminator.field];
  const branchIndex = discriminator.values.findIndex(
    (v) => JSON.stringify(v) === JSON.stringify(actual)
  );
  return branchIndex >= 0 ? branches[branchIndex] : undefined;
}

function findDiscriminator(
  branches: readonly JsonSchema[]
): { readonly field: string; readonly values: readonly unknown[] } | undefined {
  const objectBranches = branches.filter(
    (b) => b.type === "object" && b.properties
  );
  if (
    objectBranches.length !== branches.length ||
    objectBranches.length === 0
  ) {
    return undefined;
  }
  for (const propName of Object.keys(objectBranches[0]!.properties!)) {
    const values: unknown[] = [];
    for (const branch of objectBranches) {
      const prop = branch.properties![propName];
      if (prop && "const" in prop) {
        values.push(prop.const);
      } else {
        break;
      }
    }
    if (
      values.length === objectBranches.length &&
      new Set(values.map((v) => JSON.stringify(v))).size === values.length
    ) {
      return { field: propName, values };
    }
  }
  return undefined;
}

function walkSchema(
  schema: JsonSchema | undefined,
  path: string
): JsonSchema | undefined {
  if (!schema) {
    return undefined;
  }
  if (!path) {
    return schema;
  }
  let current: JsonSchema | undefined = schema;
  for (const part of path.split(".")) {
    if (!current) {
      return undefined;
    }
    if (current.properties && part in current.properties) {
      current = current.properties[part];
      continue;
    }
    if (current.items) {
      current = Array.isArray(current.items)
        ? current.items[Number(part)]
        : current.items;
      continue;
    }
    return undefined;
  }
  return current;
}

function joinPath(parent: string, child: string): string {
  if (!parent) {
    return child;
  }
  if (!child) {
    return parent;
  }
  return `${parent}.${child}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssue(issue: Issue, schema: JsonSchema): string {
  if (issue.missingProps) {
    const props = issue.missingProps.join(", ");
    const where = issue.path ? ` at ${issue.path}` : "";
    const noun = issue.missingProps.length > 1 ? "properties" : "property";
    return `missing required ${noun}${where}: ${props}`;
  }

  const expectedMatch = issue.message.match(/^expected (?:one of )?(.+)$/);
  if (expectedMatch) {
    // A `foo.type: expected one of [...]` issue is the union discriminator
    // mismatching — surface it on the union path with the allowed variants.
    const unionNode = walkSchema(schema, parentOf(issue.path));
    const branches = unionNode?.anyOf ?? unionNode?.oneOf;
    if (branches && findDiscriminator(branches)) {
      return `${parentOf(issue.path)}: ${describeAnyOf(branches)}`;
    }

    const node = walkSchema(schema, issue.path);
    const enumValues = allowedValues(node);
    if (enumValues) {
      const values = enumValues.map(displayValue).join(", ");
      return `${issue.path}: must be one of: ${values}`;
    }
    return `${issue.path}: must be ${expectedMatch[1]}`;
  }

  if (!issue.path) {
    return issue.message;
  }
  return `${issue.path}: ${issue.message}`;
}

function parentOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

function allowedValues(
  node: JsonSchema | undefined
): readonly unknown[] | undefined {
  if (!node) {
    return undefined;
  }
  if (node.enum && node.enum.length > 0) {
    return node.enum;
  }
  const branches = node.anyOf ?? node.oneOf;
  if (branches) {
    const consts = branches
      .map((b) => (b && "const" in b ? b.const : undefined))
      .filter((v) => v !== undefined);
    if (consts.length === branches.length && consts.length > 0) {
      return consts;
    }
  }
  return undefined;
}

/**
 * Recursively unwrap quoted enum values. Weaker models sometimes send
 * `"\"create\""` instead of `"create"` because the JSON Schema and earlier
 * error messages show enum values quoted. Only unwraps when the inner value is
 * a valid enum/const match, so real typos still surface as errors.
 */
function coerceQuotedEnums(
  value: unknown,
  schema: JsonSchema | undefined
): unknown {
  if (!schema) {
    return value;
  }

  if (typeof value === "string") {
    const allowed = collectAllowedStrings(schema);
    if (allowed && allowed.length > 0 && !allowed.includes(value)) {
      const unwrapped = stripWrappingQuotes(value);
      if (unwrapped !== value && allowed.includes(unwrapped)) {
        return unwrapped;
      }
    }
    return value;
  }

  if (isRecord(value)) {
    let mutated: Record<string, unknown> | undefined;
    const propSchemas = schema.properties;
    for (const key of Object.keys(value)) {
      const subSchema = propSchemas?.[key];
      const next = coerceQuotedEnums(value[key], subSchema);
      if (next !== value[key]) {
        mutated ??= { ...value };
        mutated[key] = next;
      }
    }
    if (schema.anyOf || schema.oneOf) {
      const branches = (schema.anyOf ?? schema.oneOf) as readonly JsonSchema[];
      const branch =
        matchDiscriminatedBranch(branches, mutated ?? value) ??
        branches.find((b) => b.type === "object" && b.properties);
      if (branch) {
        const recursed = coerceQuotedEnums(mutated ?? value, branch);
        if (recursed !== (mutated ?? value)) {
          return recursed;
        }
      }
    }
    return mutated ?? value;
  }

  if (Array.isArray(value)) {
    const itemsField = schema.items;
    if (!itemsField || Array.isArray(itemsField)) {
      return value;
    }
    const itemSchema = itemsField as JsonSchema;
    let mutated: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = coerceQuotedEnums(value[i], itemSchema);
      if (next !== value[i]) {
        mutated ??= [...value];
        mutated[i] = next;
      }
    }
    return mutated ?? value;
  }

  return value;
}

function collectAllowedStrings(schema: JsonSchema): string[] | undefined {
  if (schema.enum) {
    const strings = schema.enum.filter(
      (v): v is string => typeof v === "string"
    );
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof schema.const === "string") {
    return [schema.const];
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const collected: string[] = [];
    for (const branch of branches) {
      const inner = collectAllowedStrings(branch);
      if (inner) {
        collected.push(...inner);
      }
    }
    return collected.length > 0 ? collected : undefined;
  }
  return undefined;
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0]!;
  const last = value[value.length - 1]!;
  const quoteChars = ['"', "'", "`"];
  if (quoteChars.includes(first) && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Pi-ai intentionally coerces a lot of LLM-quirk inputs (`"42"` → 42,
 * `"true"` → true, single value → array, etc.) so weak/cheap models don't
 * fail on JSON shakiness. This is good. But two of those coercions are
 * almost certainly silent bugs:
 *
 * - `null` → `0` / `""` / `false` / `"null"` for primitive fields. `null`
 *   is never a sensible value for a non-nullable primitive; treating it as
 *   the type's zero value hides the model's confusion.
 * - `"42.5"` → `42` for an integer field. The float-shaped string means the
 *   model misunderstood the type; truncating loses information without
 *   recovering the intent.
 *
 * Reject both before pi's `Value.Convert` runs.
 */
function checkStrictTypes(
  value: unknown,
  schema: JsonSchema | undefined,
  path: string
): string[] {
  if (!schema) {
    return [];
  }

  const types = collectSchemaTypes(schema);
  if (types.length > 0 && !types.includes("null") && value === null) {
    return [
      `${path || "root"}: must not be null (expected ${types.join(" | ")})`,
    ];
  }

  if (
    types.includes("integer") &&
    typeof value === "string" &&
    /^-?\d+\.\d*[1-9]/.test(value)
  ) {
    return [
      `${path || "root"}: must be an integer (received "${value}" — fractional part would be truncated)`,
    ];
  }

  if (isRecord(value) && schema.properties) {
    const issues: string[] = [];
    for (const [key, sub] of Object.entries(value)) {
      const subSchema = schema.properties[key];
      if (subSchema) {
        issues.push(...checkStrictTypes(sub, subSchema, joinPath(path, key)));
      }
    }
    return issues;
  }

  if (Array.isArray(value)) {
    const itemsField = schema.items;
    if (!itemsField || Array.isArray(itemsField)) {
      return [];
    }
    const itemSchema = itemsField as JsonSchema;
    const issues: string[] = [];
    for (let i = 0; i < value.length; i++) {
      issues.push(
        ...checkStrictTypes(value[i], itemSchema, joinPath(path, String(i)))
      );
    }
    return issues;
  }

  return [];
}

/**
 * Some schemas mark a field required-but-nullable (`Type.Union([T, Type.Null()])`
 * without `Type.Optional`) so strict-mode JSON Schema function calling — which
 * requires every property to appear in `required` — still lets a model "omit"
 * an optional argument by passing `null`. Models that aren't using strict
 * sampling (or don't support it) commonly leave the property out entirely
 * instead, which is semantically the same intent but fails schema validation
 * with a "missing required property" error. Since omitted and explicit-null
 * mean the same thing for these fields, backfill missing nullable properties
 * with `null` before validation so both forms are accepted.
 */
function backfillNullableDefaults(value: unknown, schema: JsonSchema): unknown {
  if (schema.type === "object" && schema.properties && isRecord(value)) {
    let result = value;
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (!(key in result)) {
        if (isNullable(subSchema)) {
          result = result === value ? { ...value } : result;
          result[key] = null;
        }
        continue;
      }
      const next = backfillNullableDefaults(result[key], subSchema);
      if (next !== result[key]) {
        result = result === value ? { ...value } : result;
        result[key] = next;
      }
    }
    return result;
  }

  if (Array.isArray(value)) {
    const itemsField = schema.items;
    if (!itemsField || Array.isArray(itemsField)) {
      return value;
    }
    const itemSchema = itemsField as JsonSchema;
    let mutated: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = backfillNullableDefaults(value[i], itemSchema);
      if (next !== value[i]) {
        mutated ??= [...value];
        mutated[i] = next;
      }
    }
    return mutated ?? value;
  }

  return value;
}

function isNullable(schema: JsonSchema): boolean {
  if (schema.type === "null") {
    return true;
  }
  const branches = schema.anyOf ?? schema.oneOf;
  return branches ? branches.some(isNullable) : false;
}

function collectSchemaTypes(schema: JsonSchema): string[] {
  const types = new Set<string>();
  if (typeof schema.type === "string") {
    types.add(schema.type);
  }
  if (Array.isArray(schema.type)) {
    for (const t of schema.type) {
      if (typeof t === "string") {
        types.add(t);
      }
    }
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    for (const b of branches) {
      for (const t of collectSchemaTypes(b)) {
        types.add(t);
      }
    }
  }
  return Array.from(types);
}

function findUnknownTopLevelKeys(schema: JsonSchema, args: unknown): string[] {
  if (schema.type !== "object" || !schema.properties || !isRecord(args)) {
    return [];
  }
  const known = new Set(Object.keys(schema.properties));
  return Object.keys(args).filter((key) => !known.has(key));
}

function formatUnknownKeysError(
  toolName: string,
  schema: JsonSchema,
  unknownKeys: readonly string[]
): string {
  const known = schema.properties ? Object.keys(schema.properties) : [];
  const lines = unknownKeys.map((key) => {
    const suggestion = closestKey(key, known);
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    return `  - unknown property: ${key}${hint}`;
  });
  return `Validation failed for tool "${toolName}":\n${lines.join("\n")}`;
}

function closestKey(
  key: string,
  candidates: readonly string[]
): string | undefined {
  const lowered = key.toLowerCase();
  let best: { key: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === lowered) {
      return candidate;
    }
    const d = Levenshtein.distance(lowered, candidate.toLowerCase());
    if (d <= Math.max(2, Math.floor(candidate.length / 3))) {
      if (!best || d < best.distance) {
        best = { key: candidate, distance: d };
      }
    }
  }
  return best?.key;
}
