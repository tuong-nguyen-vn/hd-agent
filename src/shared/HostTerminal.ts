type Env = Readonly<Record<string, string | undefined>>;

export class HostTerminal {
  /**
   * Orca and Herdr both render OSC 8 links and route OSC 52 clipboard writes
   * to the user's machine, but pi-tui cannot identify either from inside a
   * pane: Orca runs panes in a daemon (often on a remote host) and Herdr is a
   * multiplexer, so the outer terminal's variables never reach pi.
   */
  public static isOrcaOrHerdr(env: Env = process.env): boolean {
    return (
      env["TERM_PROGRAM"]?.toLowerCase() === "orca" ||
      env["TERM_PROGRAM"]?.toLowerCase() === "herdr" ||
      env["HERDR_ENV"] === "1"
    );
  }
}
