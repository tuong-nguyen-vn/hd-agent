import { expect, test } from "bun:test";
import { RateLimiter } from "../../shared/RateLimiter";
import { ExaMcpClient } from "./ExaMcpClient";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

const captureMethod = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined
): Promise<string> => {
  if (input instanceof Request) {
    const body = (await input.clone().json()) as { method?: string };
    return body.method ?? "";
  }
  const body = JSON.parse(String(init?.body)) as { method?: string };
  return body.method ?? "";
};

const handshakeOr = (toolCallResponse: () => Response): MockFetch => {
  return async (input, init) => {
    const method = await captureMethod(input, init);

    if (method === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "session" } }
      );
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    return toolCallResponse();
  };
};

const jsonToolResponse = (): Response =>
  Response.json({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { title: "t", url: "https://example.test/t", snippet: "s" },
            ],
          }),
        },
      ],
    },
  });

const recordingLimiter = (): { limiter: RateLimiter; sleeps: number[] } => {
  let now = 0;
  const sleeps: number[] = [];
  const limiter = new RateLimiter({
    maxRequests: 1,
    windowMs: 1000,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  return { limiter, sleeps };
};

test("throttles requests on the free tier (no api key)", async () => {
  const { limiter, sleeps } = recordingLimiter();
  const client = new ExaMcpClient({
    rateLimiter: limiter,
    fetch: handshakeOr(jsonToolResponse),
  });

  await client.search({ query: "pim", numResults: 1 });

  // initialize + initialized + tools/call all draw from the one-per-window
  // budget, so the 2nd and 3rd requests wait.
  expect(sleeps).toEqual([1000, 1000]);
});

test("does not throttle when an api key is provided", async () => {
  const { limiter, sleeps } = recordingLimiter();
  const client = new ExaMcpClient({
    apiKey: "exa-key",
    rateLimiter: limiter,
    fetch: handshakeOr(jsonToolResponse),
  });

  await client.search({ query: "pim", numResults: 1 });

  expect(sleeps).toEqual([]);
});

test("parses Exa JSON results", async () => {
  const client = new ExaMcpClient({
    fetch: handshakeOr(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    title: "HD Agent docs",
                    url: "https://example.test/pim",
                    snippet: "A concise result.",
                  },
                ],
              }),
            },
          ],
        },
      })
    ),
  });

  await expect(
    client.search({ query: "pim agent", numResults: 3 })
  ).resolves.toEqual([
    {
      title: "HD Agent docs",
      url: "https://example.test/pim",
      snippet: "A concise result.",
    },
  ]);
});

test("parses Exa plain-text result blocks", async () => {
  const client = new ExaMcpClient({
    fetch: handshakeOr(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Title: First text result",
                "URL: https://example.test/first",
                "Published: N/A",
                "Author: N/A",
                "Highlights:",
                "First highlighted sentence.",
                "[...]",
                "Second highlighted sentence.",
                "",
                "---",
                "",
                "Title: Second text result",
                "URL: https://example.test/second",
                "Highlights:",
                "Another result.",
              ].join("\n"),
            },
          ],
        },
      })
    ),
  });

  await expect(
    client.search({ query: "text result", numResults: 2 })
  ).resolves.toEqual([
    {
      title: "First text result",
      url: "https://example.test/first",
      snippet: "First highlighted sentence. Second highlighted sentence.",
    },
    {
      title: "Second text result",
      url: "https://example.test/second",
      snippet: "Another result.",
    },
  ]);
});

test("falls back to REST API when MCP fails and api key is set", async () => {
  const restResponse = Response.json({
    results: [
      {
        title: "REST result",
        url: "https://example.test/rest",
        text: "snippet from rest",
      },
    ],
  });

  const client = new ExaMcpClient({
    apiKey: "exa-key",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.exa.ai")) {
        return restResponse;
      }
      // MCP handshake fails with 404
      return new Response(
        JSON.stringify({ error: { code: "404", message: "not found" } }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    },
  });

  await expect(
    client.search({ query: "fallback", numResults: 1 })
  ).resolves.toEqual([
    {
      title: "REST result",
      url: "https://example.test/rest",
      snippet: "snippet from rest",
    },
  ]);
});

test("does not fall back to REST when no api key is set", async () => {
  const client = new ExaMcpClient({
    fetch: async () =>
      new Response(
        JSON.stringify({ error: { code: "404", message: "not found" } }),
        { status: 404, headers: { "content-type": "application/json" } }
      ),
  });

  await expect(
    client.search({ query: "no fallback", numResults: 1 })
  ).rejects.toThrow();
});

test("throws clean error when REST fallback returns non-ok", async () => {
  const client = new ExaMcpClient({
    apiKey: "exa-key",
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.exa.ai")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({ error: { code: "404", message: "not found" } }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    },
  });

  await expect(
    client.search({ query: "rest error", numResults: 1 })
  ).rejects.toThrow("Exa REST search failed with HTTP 429");
});

test("throws clean errors for malformed tool envelopes", async () => {
  const client = new ExaMcpClient({
    fetch: handshakeOr(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "image", url: "https://example.test/image.png" }],
        },
      })
    ),
  });

  await expect(client.search({ query: "pim", numResults: 1 })).rejects.toThrow(
    "Exa returned malformed tool content."
  );
});
