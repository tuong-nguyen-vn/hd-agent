import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCH_STATE = Symbol.for("pim.silent-retry");

type AssistantMessageLike = {
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly content: ReadonlyArray<{ readonly type: string }>;
};

type AssistantMessagePrototype = {
  updateContent: (message: AssistantMessageLike) => void;
  [PATCH_STATE]?: true;
};

type AssistantMessageConstructor = Function & {
  readonly prototype: AssistantMessagePrototype;
};

type IsRetryableAssistantError = (error: unknown) => boolean;

function isAssistantMessageConstructor(
  value: unknown
): value is AssistantMessageConstructor {
  const ctor = value as AssistantMessageConstructor | undefined;
  return (
    typeof ctor === "function" &&
    !!ctor.prototype &&
    typeof ctor.prototype.updateContent === "function"
  );
}

// Lazy-loaded to avoid importing pi-coding-agent and pi-ai values at module
// load time, which triggers loading a second copy from hd-agent's own
// node_modules (~700-1000ms). The dynamic import uses Bun's native import
// and runs in the factory, not at module-import time.
let cachedIsRetryable: IsRetryableAssistantError | undefined;

async function getIsRetryableAssistantError(): Promise<IsRetryableAssistantError> {
  if (cachedIsRetryable) {
    return cachedIsRetryable;
  }
  const { isRetryableAssistantError } =
    (await import("@earendil-works/pi-ai")) as {
      isRetryableAssistantError: IsRetryableAssistantError;
    };
  cachedIsRetryable = isRetryableAssistantError;
  return isRetryableAssistantError;
}

// Pi can have multiple pi-coding-agent copies (hoisted + nested). Patch every
// reachable one so the live UI instance is covered.
async function resolveAssistantMessageConstructors(): Promise<
  AssistantMessageConstructor[]
> {
  const constructors = new Set<AssistantMessageConstructor>();

  const entries = new Set<string>();
  const argv1 = process.argv[1];
  if (argv1) {
    entries.add(argv1);
  }
  const bunMain = typeof Bun !== "undefined" ? Bun.main : undefined;
  if (bunMain) {
    entries.add(bunMain);
  }

  const modulePaths = new Set<string>();
  for (const entry of entries) {
    try {
      modulePaths.add(
        createRequire(entry).resolve("@earendil-works/pi-coding-agent")
      );
    } catch {
      // Some entry shims are not valid require roots; the manual walk covers them.
    }
    let dir = dirname(entry);
    while (true) {
      const candidate = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "index.js"
      );
      if (existsSync(candidate)) {
        modulePaths.add(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  for (const modulePath of modulePaths) {
    try {
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        AssistantMessageComponent?: unknown;
      };
      if (isAssistantMessageConstructor(mod.AssistantMessageComponent)) {
        constructors.add(
          mod.AssistantMessageComponent as AssistantMessageConstructor
        );
      }
    } catch {
      // Ignore unreadable copies; the others may still be the live one.
    }
  }

  return [...constructors];
}

export default async function (pi: ExtensionAPI): Promise<void> {
  await applySilentRetryPatches();

  pi.on("session_start", async () => {
    await applySilentRetryPatches();
  });
}

async function applySilentRetryPatches(): Promise<number> {
  const isRetryableAssistantError = await getIsRetryableAssistantError();
  let patched = 0;
  for (const ctor of await resolveAssistantMessageConstructors()) {
    const prototype = ctor.prototype;
    if (prototype[PATCH_STATE]) {
      continue;
    }

    const originalUpdateContent = prototype.updateContent;
    prototype[PATCH_STATE] = true;

    // Suppress the "Error: <message>" line for retryable provider errors.
    // Pi core will auto-retry the turn and show "Retrying (n/m)..." via
    // RetryStatusIndicator. If all retries are exhausted, auto_retry_end
    // surfaces the error once via showError. Non-retryable errors (quota,
    // billing, context overflow) are still rendered immediately.
    prototype.updateContent = function (message: AssistantMessageLike): void {
      if (
        message.stopReason === "error" &&
        !message.content.some((c) => c.type === "toolCall") &&
        isRetryableAssistantError(message)
      ) {
        // Pass a copy without stopReason so the original updateContent skips
        // the "Error: <message>" line. The original message object keeps
        // stopReason/errorMessage so pi core's retry logic still fires.
        originalUpdateContent.call(this, { ...message, stopReason: undefined });
        return;
      }
      originalUpdateContent.call(this, message);
    };

    patched++;
  }
  return patched;
}
