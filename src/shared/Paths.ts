import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class Paths {
  public static pimHomeDir(): string {
    return Paths.expandHome(process.env.PIM_HOME_DIR ?? "~/.pim");
  }

  public static resolve(value: string, baseDir: string): string {
    const expanded = Paths.expandHome(value);
    return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  }

  public static toForwardSlashes(path: string): string {
    return sep === "/" ? path : path.split(sep).join("/");
  }

  public static expandHome(value: string): string {
    if (value === "~") {
      return homedir();
    }

    if (value.startsWith("~/")) {
      return resolve(homedir(), value.slice(2));
    }

    return value;
  }

  public static abbreviateHome(path: string): string {
    const home = homedir();
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  }

  public static displayRelative(path: string, cwd: string): string {
    const rel = relative(cwd, path);

    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return path;
    }

    return rel;
  }

  public static titleOr(
    path: string | undefined,
    cwd: string,
    placeholder = "..."
  ): string {
    return path ? Paths.displayRelative(path, cwd) : placeholder;
  }

  /**
   * Render a " (in: <relative>)" suffix when `cwd` resolves to a directory
   * different from `baseCwd`. Returns an empty string when `cwd` is unset or
   * equal to `baseCwd`, so callers can append it unconditionally.
   */
  public static cwdSuffix(
    cwd: string | null | undefined,
    baseCwd: string
  ): string {
    if (!cwd) {
      return "";
    }
    const resolved = Paths.resolve(cwd, baseCwd);
    if (resolved === baseCwd) {
      return "";
    }
    return ` (in: ${Paths.abbreviateHome(Paths.displayRelative(resolved, baseCwd))})`;
  }

  /**
   * Expand `~` and assert the result is absolute. Throws for relative paths
   * so callers can reject non-absolute `cwd` values early. Returns the
   * expanded absolute path.
   */
  public static requireAbsolute(path: string): string {
    const expanded = Paths.expandHome(path);
    if (!isAbsolute(expanded)) {
      throw new Error(`Path must be absolute, not relative: ${path}`);
    }
    return expanded;
  }
}
