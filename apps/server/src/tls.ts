import { join } from "node:path";

/**
 * Where the TLS cert and key live, the mkcert command that makes them for `hosts`, and the hosts that only a cert can
 * serve. Shared with `pnpm preflight`, so it blocks start exactly when `serve` would refuse.
 */
export function tlsSetup(home: string, hosts: string[]) {
  const [cert, key] = ["cert.pem", "key.pem"].map((name) => join(home, "tls", name));
  return {
    cert,
    key,
    mkcert: `mkdir -p ${join(home, "tls")} && mkcert -cert-file ${cert} -key-file ${key} localhost ${hosts.join(" ")}`,
    remote: hosts.filter((host) => !(host === "localhost" || host === "::1" || host.startsWith("127."))),
  };
}
