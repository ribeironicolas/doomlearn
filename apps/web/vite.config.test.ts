import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

/**
 * The address `pnpm preview` listens on besides localhost, for a data folder holding `config` (none when undefined)
 * and, when `cert` is set, a TLS cert and key.
 */
async function previewHost(config: object | undefined, cert = true) {
  const home = await mkdtemp(join(tmpdir(), "doomlearn-preview-"));
  if (config) await writeFile(join(home, "config.json"), JSON.stringify(config));
  if (cert) {
    await mkdir(join(home, "tls"));
    await Promise.all(["cert.pem", "key.pem"].map((file) => writeFile(join(home, "tls", file), "")));
  }
  vi.stubEnv("DOOMLEARN_HOME", home);
  vi.resetModules();
  const { default: vite } = await import("./vite.config.ts");
  return (vite as { preview: { host: string } }).preview.host;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a v2 config listens on its non-loopback server.hosts address", async () => {
  assert.equal(await previewHost({ server: { hosts: ["127.0.0.1", "10.0.0.2"] } }), "10.0.0.2");
});

test("a v1 config that start has not migrated yet listens on its zerotierIp", async () => {
  assert.equal(await previewHost({ zerotierIp: "10.0.0.2" }), "10.0.0.2");
});

test("only loopback hosts, no config or no cert serve localhost only", async () => {
  assert.equal(await previewHost({ server: { hosts: ["127.0.0.1", "localhost", "::1"] } }), "localhost");
  assert.equal(await previewHost({ $schema: "./config.schema.json" }), "localhost");
  assert.equal(await previewHost(undefined, false), "localhost");
  assert.equal(await previewHost({ server: { hosts: ["127.0.0.1", "10.0.0.2"] } }, false), "localhost");
});
