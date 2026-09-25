import type {
  ExtensionAPI,
  ExtensionHandler,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { withMcpRenderer } from "./render";

type McpAdapter = (pi: ExtensionAPI) => void;
type SessionStartHandler = ExtensionHandler<SessionStartEvent>;

// Records the adapter's session_start handlers so they can be replayed:
// since pi 0.86, handlers registered mid-dispatch only apply to later
// dispatches, so the adapter's own handler would miss the session that
// loaded it and leave MCP uninitialized.
function captureSessionStart(
  pi: ExtensionAPI,
  handlers: SessionStartHandler[]
): ExtensionAPI {
  const on = pi.on.bind(pi) as (
    event: string,
    handler: ExtensionHandler<unknown, unknown>
  ) => () => void;
  const wrapped = Object.create(pi) as ExtensionAPI;
  wrapped.on = ((
    event: string,
    handler: ExtensionHandler<unknown, unknown>
  ) => {
    if (event === "session_start") {
      handlers.push(handler as SessionStartHandler);
    }
    return on(event, handler);
  }) as ExtensionAPI["on"];
  return wrapped;
}

// Deferred to session_start so the heavy pi-mcp-adapter dynamic import
// (~400-540ms) doesn't block the critical startup path. The proxy tool,
// direct tools, flag, and commands are all registered inside mcpAdapter;
// session_start fires before the first agent turn so tools are ready in time.
export default function (pi: ExtensionAPI): void {
  let initialized = false;

  pi.on("session_start", async (event, ctx) => {
    if (initialized) {
      return;
    }
    initialized = true;
    try {
      const moduleName: string = "pi-mcp-adapter";
      const { default: mcpAdapter } = (await import(moduleName)) as {
        readonly default: McpAdapter;
      };
      const startHandlers: SessionStartHandler[] = [];
      mcpAdapter(captureSessionStart(withMcpRenderer(pi), startHandlers));
      for (const handler of startHandlers) {
        await handler(event, ctx);
      }
    } catch (error) {
      console.error(
        "hd-agent: failed to load pi-mcp-adapter:",
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}
