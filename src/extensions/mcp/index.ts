import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withMcpRenderer } from "./render";

type McpAdapter = (pi: ExtensionAPI) => void;

// Deferred to session_start so the heavy pi-mcp-adapter dynamic import
// (~400-540ms) doesn't block the critical startup path. The proxy tool,
// direct tools, flag, and commands are all registered inside mcpAdapter;
// session_start fires before the first agent turn so tools are ready in time.
export default function (pi: ExtensionAPI): void {
  let initialized = false;

  pi.on("session_start", async () => {
    if (initialized) {
      return;
    }
    initialized = true;
    try {
      const moduleName: string = "pi-mcp-adapter";
      const { default: mcpAdapter } = (await import(moduleName)) as {
        readonly default: McpAdapter;
      };
      mcpAdapter(withMcpRenderer(pi));
    } catch (error) {
      console.error(
        "hd-agent: failed to load pi-mcp-adapter:",
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}
