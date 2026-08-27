import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withBoundedOverlay } from "./bounded-overlay";

// Load the upstream extension lazily through a non-literal dynamic import. The
// vendor ships raw (type-unclean) TypeScript, so a static `import` would pull
// its sources into HD Agent's strict typecheck program and fail `tsgo --noEmit`.
// A runtime-resolved specifier keeps the upstream module out of typechecking
// while Bun still resolves it from node_modules at runtime, so following the
// vendor stays a version bump on the pinned dependency.
const UPSTREAM_SPEC = "@juicesharp/rpiv-ask-user-question";

// Emitted by the upstream tool while its questionnaire overlay is awaiting
// input (and cleared with active:false in finally).
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

// Herdr's pi integration (~/.pi/agent/extensions/herdr-agent-state.ts) listens
// for this to flip the pane to "blocked" instead of "working". Herdr treats pi
// as a full lifecycle authority and skips screen detection, so without this
// bridge the questionnaire keeps reporting "working" the whole time it is open.
const HERDR_BLOCKED_EVENT = "herdr:blocked";

const TOOL_NAME = "ask_user_question";

// The upstream loader calls `pi.registerTool` itself, so the overlay cap has
// to be spliced in at registration time rather than by re-registering.
function interceptToolRegistration(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, prop, _receiver) {
      if (prop === "registerTool") {
        return (def: Parameters<ExtensionAPI["registerTool"]>[0]) =>
          target.registerTool(
            def.name === TOOL_NAME ? withBoundedOverlay(def) : def
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const { default: loader } = await import(UPSTREAM_SPEC as string);
  loader(interceptToolRegistration(pi));

  pi.events.on(ASK_USER_BLOCKED_EVENT, (data) => {
    const active = (data as { active?: boolean } | null)?.active === true;
    pi.events.emit(
      HERDR_BLOCKED_EVENT,
      active
        ? { active: true, label: "Awaiting your answer" }
        : { active: false }
    );
  });
}
