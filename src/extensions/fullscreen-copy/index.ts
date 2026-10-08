import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AltScreen, type AltScreenConstructor } from "../../shared/AltScreen";
import { HostTerminal } from "../../shared/HostTerminal";

const PATCH_STATE = Symbol.for("pim.fullscreen-copy");
// Matches pi's own cap; terminals drop or truncate larger OSC 52 payloads.
const MAX_OSC52_ENCODED_LENGTH = 100_000;

type CopyingAltScreen = {
  readonly terminal: { write(data: string): void };
  readonly copySelection?: (text: string) => Promise<boolean | string>;
  flash(message: string): void;
  copyTextToClipboard(text: string): Promise<boolean>;
};

type CopyingAltScreenPrototype = CopyingAltScreen & {
  [PATCH_STATE]?: true;
};

function hasClipboardCopy(
  value: AltScreenConstructor
): value is AltScreenConstructor & {
  readonly prototype: CopyingAltScreenPrototype;
} {
  const prototype = value.prototype as Partial<CopyingAltScreenPrototype>;
  return typeof prototype.copyTextToClipboard === "function";
}

/**
 * pi's fullscreen copy writes the clipboard of the machine pi runs on (xclip,
 * pbcopy, ...) and only adds OSC 52 for SSH or display-less sessions. Under
 * Orca or Herdr attached from another machine that native write succeeds,
 * "Copied!" flashes, and the user's own clipboard never changes. Both route
 * OSC 52 to the user's machine, so always send it there.
 */
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    if (!HostTerminal.isOrcaOrHerdr()) {
      return;
    }
    for (const ctor of await AltScreen.constructors()) {
      if (!hasClipboardCopy(ctor)) {
        continue;
      }
      const prototype = ctor.prototype;
      if (prototype[PATCH_STATE]) {
        continue;
      }

      const originalCopy = prototype.copyTextToClipboard;
      prototype[PATCH_STATE] = true;
      prototype.copyTextToClipboard = async function (
        text: string
      ): Promise<boolean> {
        const self = this as CopyingAltScreen;
        const encoded = Buffer.from(text).toString("base64");
        if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
          return originalCopy.call(self, text);
        }
        self.terminal.write(`\x1b]52;c;${encoded}\x07`);
        // The native copy still helps when the user sits at the machine pi
        // runs on, but its failure must not report "Copy failed" after the
        // terminal already took the OSC 52 write.
        try {
          await self.copySelection?.(text);
        } catch {
          // Best-effort.
        }
        self.flash("Copied!");
        return true;
      };
    }
  });
}
