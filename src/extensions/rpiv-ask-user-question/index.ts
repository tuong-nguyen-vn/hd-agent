import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default async function (pi: ExtensionAPI): Promise<void> {
  const { default: loader } = await import(UPSTREAM_SPEC as string);
  loader(pi);

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
