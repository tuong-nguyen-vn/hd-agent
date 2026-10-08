import { describe, expect, test } from "bun:test";
import { HostTerminal } from "./HostTerminal";

describe("HostTerminal.isOrcaOrHerdr", () => {
  test("recognises Orca and Herdr panes", () => {
    expect(HostTerminal.isOrcaOrHerdr({ TERM_PROGRAM: "Orca" })).toBe(true);
    expect(HostTerminal.isOrcaOrHerdr({ TERM_PROGRAM: "herdr" })).toBe(true);
    expect(
      HostTerminal.isOrcaOrHerdr({ TERM_PROGRAM: "vscode", HERDR_ENV: "1" })
    ).toBe(true);
  });

  test("ignores other terminals", () => {
    expect(HostTerminal.isOrcaOrHerdr({ TERM_PROGRAM: "vscode" })).toBe(false);
    expect(HostTerminal.isOrcaOrHerdr({ HERDR_ENV: "0" })).toBe(false);
    expect(HostTerminal.isOrcaOrHerdr({})).toBe(false);
  });
});
