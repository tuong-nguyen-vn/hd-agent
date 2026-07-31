import { McpClient, type McpFetch } from "../../shared/McpClient";
import { RateLimiter } from "../../shared/RateLimiter";

type RestSearchResult = {
  readonly title?: string;
  readonly url?: string;
  readonly text?: string;
  readonly snippet?: string;
  readonly summary?: string;
};

type ExaMcpClientOptions = {
  readonly endpoint?: string;
  readonly restEndpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: McpFetch;
  readonly rateLimiter?: RateLimiter;
};

type ExaSearchInput = {
  readonly query: string;
  readonly numResults: number;
  readonly signal?: AbortSignal;
};

export type ExaSearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

class ExaSearchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExaSearchError";
  }
}

export class ExaMcpClient {
  private static readonly defaultEndpoint = "https://mcp.exa.ai/mcp";
  private static readonly defaultRestEndpoint = "https://api.exa.ai/search";
  private static readonly toolName = "web_search_exa";
  private static readonly maxRequestsPerWindow = 3;
  private static readonly windowMs = 1000;

  private readonly client: McpClient;
  private readonly restEndpoint: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: McpFetch;

  public constructor(options: ExaMcpClientOptions = {}) {
    const apiKey =
      options.apiKey === undefined || options.apiKey.length === 0
        ? undefined
        : options.apiKey;
    // Throttle only on the free tier; an API key lifts the request rate limit.
    const rateLimiter =
      apiKey !== undefined
        ? undefined
        : (options.rateLimiter ??
          new RateLimiter({
            maxRequests: ExaMcpClient.maxRequestsPerWindow,
            windowMs: ExaMcpClient.windowMs,
          }));

    this.apiKey = apiKey;
    this.restEndpoint = options.restEndpoint ?? ExaMcpClient.defaultRestEndpoint;
    this.fetchFn = options.fetch ?? fetch;
    this.client = new McpClient({
      endpoint: options.endpoint ?? ExaMcpClient.defaultEndpoint,
      ...(apiKey === undefined ? {} : { headers: { "x-api-key": apiKey } }),
      ...(rateLimiter === undefined ? {} : { rateLimiter }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  public async search(
    input: ExaSearchInput
  ): Promise<readonly ExaSearchResult[]> {
    try {
      const result = await this.client.callTool({
        name: ExaMcpClient.toolName,
        arguments: {
          query: input.query,
          numResults: input.numResults,
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      return extractResults(result);
    } catch (error) {
      if (input.signal?.aborted) {
        throw error;
      }
      // Fall back to the REST API when the MCP endpoint is unavailable.
      // Requires an API key; the free-tier OAuth path has no REST equivalent.
      if (this.apiKey === undefined) {
        throw error;
      }
      return this.restSearch(input);
    }
  }

  private async restSearch(
    input: ExaSearchInput
  ): Promise<readonly ExaSearchResult[]> {
    const response = await this.fetchFn(this.restEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey!,
      },
      body: JSON.stringify({
        query: input.query,
        numResults: input.numResults,
        contents: { text: true },
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (!response.ok) {
      throw new ExaSearchError(
        `Exa REST search failed with HTTP ${response.status}: ${await excerptBody(response)}`
      );
    }

    const body = (await response.json()) as {
      readonly results?: readonly RestSearchResult[];
    };

    if (!Array.isArray(body.results) || body.results.length === 0) {
      throw new ExaSearchError("Exa REST search returned no results.");
    }

    return body.results.map(projectRestResult);
  }
}

function extractResults(result: unknown): readonly ExaSearchResult[] {
  const record = asRecord(result);
  const content = record?.["content"];

  if (!Array.isArray(content) || content.length === 0) {
    throw new ExaSearchError("Exa returned malformed tool content.");
  }

  const textBlocks = content.map(readTextBlock);
  const plainTextResults = extractPlainTextResults(textBlocks);

  if (plainTextResults !== undefined) {
    return plainTextResults;
  }

  const resultObjects = findFirstObjectArray(
    textBlocks
      .map((block) => tryParseJson(block))
      .filter((value) => value !== undefined)
  );

  if (resultObjects === undefined) {
    throw new ExaSearchError("Exa returned malformed search results.");
  }

  return resultObjects.map(projectResult);
}

function readTextBlock(block: unknown): string {
  const record = asRecord(block);

  if (record?.["type"] !== "text" || typeof record["text"] !== "string") {
    throw new ExaSearchError("Exa returned malformed tool content.");
  }

  return record["text"];
}

function extractPlainTextResults(
  textBlocks: readonly string[]
): readonly ExaSearchResult[] | undefined {
  for (const textBlock of textBlocks) {
    const blocks = textBlock
      .split(/\n---\n/u)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);
    const results = blocks
      .map((block) => parsePlainTextResult(block))
      .filter((result) => result !== undefined);

    if (results.length > 0) {
      return results;
    }
  }

  return undefined;
}

function parsePlainTextResult(block: string): ExaSearchResult | undefined {
  const lines = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const title = readLabeledLine(lines, "Title");
  const url = readLabeledLine(lines, "URL");

  if (title === undefined || url === undefined) {
    return undefined;
  }

  return {
    title,
    url,
    snippet: readPlainTextSnippet(lines),
  };
}

function readLabeledLine(
  lines: readonly string[],
  label: string
): string | undefined {
  const prefix = `${label}:`;
  const line = lines.find((candidate) =>
    candidate.toLowerCase().startsWith(prefix.toLowerCase())
  );

  return line?.slice(prefix.length).trim();
}

function readPlainTextSnippet(lines: readonly string[]): string {
  const highlightsIndex = lines.findIndex((line) =>
    line.toLowerCase().startsWith("highlights:")
  );
  const snippetLines =
    highlightsIndex === -1 ? lines : lines.slice(highlightsIndex + 1);
  const skipPrefixes = ["title:", "url:", "published:", "author:"];
  const snippet = snippetLines
    .filter((line) => {
      if (line.startsWith("[...]")) {
        return false;
      }
      const lower = line.toLowerCase();
      return !skipPrefixes.some((prefix) => lower.startsWith(prefix));
    })
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  return snippet.length > 500 ? `${snippet.slice(0, 500)}...` : snippet;
}

function findFirstObjectArray(
  values: readonly unknown[]
): readonly Readonly<Record<string, unknown>>[] | undefined {
  for (const value of values) {
    if (
      Array.isArray(value) &&
      value.every((item) => asRecord(item) !== undefined)
    ) {
      return value as readonly Readonly<Record<string, unknown>>[];
    }

    const record = asRecord(value);

    if (record === undefined) {
      continue;
    }

    for (const nestedValue of Object.values(record)) {
      if (
        Array.isArray(nestedValue) &&
        nestedValue.every((item) => asRecord(item) !== undefined)
      ) {
        return nestedValue as readonly Readonly<Record<string, unknown>>[];
      }
    }
  }

  return undefined;
}

function projectResult(
  result: Readonly<Record<string, unknown>>
): ExaSearchResult {
  return {
    title: readResultString(result, "title"),
    url: readResultString(result, "url"),
    snippet: readSnippet(result),
  };
}

function readSnippet(result: Readonly<Record<string, unknown>>): string {
  return (
    readOptionalResultString(result, "snippet") ??
    readOptionalResultString(result, "text") ??
    readOptionalResultString(result, "summary") ??
    ""
  );
}

function readResultString(
  result: Readonly<Record<string, unknown>>,
  name: string
): string {
  const value = readOptionalResultString(result, name);

  if (value === undefined) {
    throw new ExaSearchError(`Exa returned a result without ${name}.`);
  }

  return value;
}

function readOptionalResultString(
  result: Readonly<Record<string, unknown>>,
  name: string
): string | undefined {
  const value = result[name];

  return typeof value === "string" ? value : undefined;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function projectRestResult(result: RestSearchResult): ExaSearchResult {
  const title = result.title;
  const url = result.url;

  if (title === undefined || url === undefined) {
    throw new ExaSearchError("Exa REST returned a result without title or url.");
  }

  const snippet =
    result.snippet ?? result.summary ?? result.text ?? "";

  return {
    title,
    url,
    snippet: snippet.length > 500 ? `${snippet.slice(0, 500)}...` : snippet,
  };
}

async function excerptBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  } catch {
    return "<empty>";
  }
}

function asRecord(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Readonly<Record<string, unknown>>;
}
