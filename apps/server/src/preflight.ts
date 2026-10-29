import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, InvalidConfig, parseConfig } from "@doomlearn/core/config";
import { readJson } from "@doomlearn/core/json";
import { mediaPreflight } from "@doomlearn/media/tools";
import { tlsSetup } from "./tls.ts";

/**
 * The oldest Node major doomlearn runs on.
 */
const MIN_NODE = 24;

/**
 * How to install each Provider's CLI.
 */
const PROVIDER_HINT = { claude: "brew install --cask claude-code", codex: "brew install --cask codex" };

/**
 * Runs `command args` and resolves its stdout, or undefined when it is missing or fails.
 */
function probe(command: string, args: string[]) {
  return new Promise<string | undefined>((resolve) =>
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => resolve(error ? undefined : stdout)),
  );
}

/**
 * Checks what `pnpm start` needs on this Mac and says how to install each missing piece, without installing or
 * writing anything. Only what stops the server itself blocks start: an old Node, or a non-loopback host in
 * `server.hosts` without a TLS cert. Every other miss is a ✗ line and start goes on: the feature that needs it fails
 * with its reason, and buffered Clips keep playing. The media environments come from the worker's own preflight.
 */
export async function preflight(
  home: string,
  {
    node = process.versions.node,
    platform = process.platform as string,
    arch = process.arch as string,
    run = probe,
    media = mediaPreflight,
  } = {},
) {
  const lines: string[] = [];
  let blocked = false;
  /**
   * Adds a ✓ line when `ok`, else the `miss` line marked ✗ (⚠ when only a `warning`), blocking start if it `blocks`.
   */
  const check = (ok: boolean, label: string, miss: string, { warning = false, blocks = false } = {}) => {
    lines.push(ok ? `✓ ${label}` : `${warning ? "⚠" : "✗"} ${miss}`);
    if (!ok && blocks) blocked = true;
  };

  let config: Config;
  let unread = false;
  try {
    const file = join(home, "config.json");
    config = parseConfig(existsSync(file) ? readJson(file, InvalidConfig) : {});
  } catch (error) {
    if (!(error instanceof InvalidConfig)) throw error;
    config = parseConfig({});
    unread = true;
  }

  check(
    Number(node.split(".")[0]) >= MIN_NODE,
    `Node ${node}`,
    `Node ${node} is too old, doomlearn needs ${MIN_NODE} or later: brew install node`,
    { blocks: true },
  );
  check(
    platform === "darwin" && arch === "arm64",
    "macOS on Apple Silicon",
    `not macOS on Apple Silicon (${platform} ${arch}): TTS and alignment run only there, the Feed still serves`,
  );
  check(
    (await run("ebook-convert", ["--version"])) !== undefined,
    "Calibre",
    "Calibre not found, so ebook Sources cannot convert: brew install --cask calibre",
  );
  check(
    (await run("python3", ["--version"])) !== undefined,
    "python3",
    "python3 not found, so `pnpm bootstrap` cannot install uv: xcode-select --install, or brew install python",
  );
  // The voice of the Language of new Clips too; a queued job in another Language is the worker preflight's.
  const { problems, interpreters } = await media([config.worker.language]);
  if (problems.length) lines.push(...problems.map((problem) => `✗ ${problem}`));
  else lines.push(`✓ media environments on ${interpreters.join(", ")}`);

  const caRoot = (await run("mkcert", ["-CAROOT"]))?.trim();
  if (caRoot === undefined) lines.push("✗ mkcert not found, needed for phone access: brew install mkcert");
  else
    check(
      existsSync(join(caRoot, "rootCA.pem")),
      "mkcert CA",
      "mkcert CA not installed, needed for phone access: mkcert -install",
    );
  const tls = tlsSetup(home, config.server.hosts);
  check(
    existsSync(tls.cert) && existsSync(tls.key),
    "TLS cert",
    tls.remote.length
      ? `no TLS cert for ${tls.remote.join(", ")}, so start refuses: ${tls.mkcert}`
      : "no TLS cert, so the Feed is on this Mac only: phone access is in docs/OPS.md",
    { blocks: tls.remote.length > 0 },
  );
  check(
    (await run("zerotier-cli", ["-v"])) !== undefined,
    "ZeroTier",
    "ZeroTier not found, needed for phone access: brew install --cask zerotier-one",
    { warning: true },
  );

  // Only the Providers a stage is set to; whether each is logged in is the worker's preflight.
  for (const provider of new Set(Object.values(config.agents.stages).map((stage) => stage.provider)))
    check(
      (await run(provider, ["--version"])) !== undefined,
      provider,
      `${provider} not found, needed by the stages set to it: ${PROVIDER_HINT[provider]}`,
    );
  if (unread) lines.push("⚠ config.json not checked here: `pnpm start` validates it, and rewrites a v1 file");
  return { lines, blocked };
}

if (import.meta.main) {
  const { lines, blocked } = await preflight(process.env.DOOMLEARN_HOME ?? join(homedir(), "doomlearn"));
  console.log(lines.join("\n"));
  if (blocked) {
    console.error("preflight: doomlearn cannot start until the Node or TLS cert line above is fixed");
    process.exitCode = 1;
  }
}
