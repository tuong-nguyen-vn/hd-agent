import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Load the upstream extension lazily through a non-literal dynamic import. The
// vendor ships raw (type-unclean) TypeScript, so a static `import` would pull
// its sources into HD Agent's strict typecheck program and fail `tsgo --noEmit`.
// A runtime-resolved specifier keeps the upstream module out of typechecking
// while Bun still resolves it from node_modules at runtime, so following the
// vendor stays a version bump on the pinned dependency.
const UPSTREAM_SPEC = "@juicesharp/rpiv-ask-user-question";

export default async function (pi: ExtensionAPI): Promise<void> {
  const { default: loader } = await import(UPSTREAM_SPEC as string);
  loader(pi);
}
