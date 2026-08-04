#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

async function findPiCli(): Promise<string> {
  const envCli = await resolveEnvPiCli();
  if (envCli) {
    return envCli;
  }

  const pathCli = await resolvePathPiCli();
  if (pathCli) {
    return pathCli;
  }

  const globalCli = resolveGlobalPiCli();
  if (globalCli) {
    return globalCli;
  }

  try {
    const pkgUrl = import.meta.resolve(`${PI_PACKAGE}/package.json`);
    return join(dirname(Bun.fileURLToPath(pkgUrl)), "dist/cli.js");
  } catch {
    throw new Error(
      `HD Agent could not locate ${PI_PACKAGE}.\n` +
        `Install Pi from https://pi.dev/docs/latest/quickstart, or set PIM_PI_CLI=/path/to/cli.js`
    );
  }
}

async function resolveEnvPiCli(): Promise<string | null> {
  const candidate = process.env["PIM_PI_CLI"]?.trim();
  if (!candidate) {
    return null;
  }
  return (await isFile(candidate)) ? candidate : null;
}

// HD Agent also installs a `pi` bin, so the first `pi` on PATH may be this launcher.
// Walk every PATH entry until one resolves into the real Pi package.
async function resolvePathPiCli(): Promise<string | null> {
  let searchDirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);

  while (searchDirs.length > 0) {
    const piBin = Bun.which("pi", { PATH: searchDirs.join(delimiter) });
    if (!piBin) {
      return null;
    }

    const cliPath = await resolveRealPath(piBin);
    if (await isPiPackageCli(cliPath)) {
      return cliPath;
    }

    const skipped = resolve(dirname(piBin));
    const remaining = searchDirs.filter((dir) => resolve(dir) !== skipped);
    // Bail out instead of looping forever if the rejected bin's directory
    // cannot be traced back to a PATH entry.
    if (remaining.length === searchDirs.length) {
      return null;
    }
    searchDirs = remaining;
  }

  return null;
}

async function isPiPackageCli(cliPath: string): Promise<boolean> {
  const pkgPath = join(dirname(cliPath), "..", "package.json");
  try {
    const pkg = (await Bun.file(pkgPath).json()) as { readonly name?: string };
    return pkg.name === PI_PACKAGE;
  } catch {
    return false;
  }
}

async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isFile();
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory();
  } catch {
    return false;
  }
}

function resolveGlobalPiCli(): string | null {
  const result = Bun.spawnSync({ cmd: ["bun", "pm", "-g", "bin"] });
  if (result.exitCode !== 0) {
    return null;
  }
  const binDir = result.stdout.toString().trim();
  if (!binDir) {
    return null;
  }
  const cliPath = join(
    binDir,
    "..",
    "install",
    "global",
    "node_modules",
    PI_PACKAGE,
    "dist",
    "cli.js"
  );
  return Bun.file(cliPath).size > 0 ? cliPath : null;
}

const cliArgs = process.argv.slice(2);

// Pi's argparse rejects prompts beginning with `-` and doesn't honour `--`
// itself; do the split here and forward the prompt via pi's stdin instead.
const dashDashIdx = cliArgs.indexOf("--");
let promptViaStdin: string | undefined;
if (dashDashIdx >= 0) {
  promptViaStdin = cliArgs.slice(dashDashIdx + 1).join(" ");
  cliArgs.length = dashDashIdx;
}

// When launched inside an hd-agent repo (cwd has src/extensions), pi would load
// the repo's own extensions via .pi/settings.json on top of the globally
// installed HD Agent, causing "Tool X conflicts with Y" for every extension.
// Skip project-local resources unless the user explicitly opts in with
// --approve/-a. An explicit --no-approve/-na is still honoured as-is.
const hasExplicitTrustFlag = cliArgs.some(
  (a) => a === "--approve" || a === "-a" || a === "--no-approve" || a === "-na"
);
if (
  !hasExplicitTrustFlag &&
  (await isDir(join(process.cwd(), "src/extensions")))
) {
  cliArgs.push("--no-approve");
}

const modeIdx = cliArgs.findIndex(
  (a) => a === "--mode" || a.startsWith("--mode=")
);
const mode =
  modeIdx >= 0
    ? cliArgs[modeIdx]!.includes("=")
      ? cliArgs[modeIdx]!.split("=")[1]
      : cliArgs[modeIdx + 1]
    : undefined;
if (mode === "telegram") {
  if (cliArgs.includes("--install")) {
    const { Supervisor } = await import("../src/telegram/Supervisor.ts");
    await Supervisor.install();
    process.exit(0);
  }
  if (cliArgs.includes("--uninstall")) {
    const { Supervisor } = await import("../src/telegram/Supervisor.ts");
    await Supervisor.uninstall();
    process.exit(0);
  }
  const { start } = await import("../src/telegram/index.ts");
  await start(cliArgs);
  process.exit(0);
}

const piCli = await findPiCli();
const startupRenderPreload = join(import.meta.dir, "startup-render.ts");
const childEnv: NodeJS.ProcessEnv = { ...process.env, AMP_PI_CLI: piCli };
if (childEnv["HERDR_ENV"] === "1" && !childEnv["HERDR_AGENT"]) {
  childEnv["HERDR_AGENT"] = "pi";
}
const proc = Bun.spawn({
  cmd: [process.execPath, "--preload", startupRenderPreload, piCli, ...cliArgs],
  stdio: [
    promptViaStdin === undefined ? "inherit" : "pipe",
    "inherit",
    "inherit",
  ],
  env: childEnv,
});
if (promptViaStdin !== undefined && proc.stdin) {
  proc.stdin.write(promptViaStdin);
  proc.stdin.end();
}
// Forward shutdown signals so pi's bash subtrees aren't orphaned on the host.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(sig, () => {
    try {
      proc.kill(sig);
    } catch {}
  });
}
const exitCode = await proc.exited;
const signalCode = proc.signalCode as NodeJS.Signals | null;
if (signalCode) {
  process.kill(process.pid, signalCode);
} else {
  process.exit(exitCode ?? 0);
}
