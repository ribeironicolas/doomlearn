import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

//
// The phone can preview a change on its own HTTPS origin (`pnpm preview`) before it is deployed: the server's mkcert
// cert, on the Mac's ZeroTier IP, with /api and /clips proxied to the server. A separate origin has its own service
// worker and storage, so the installed app's press queue and caches are never touched.
//

const home = process.env.DOOMLEARN_HOME ?? join(homedir(), "doomlearn");
const [cert, key, config] = ["tls/cert.pem", "tls/key.pem", "config.json"].map((file) => join(home, file));
/**
 * Off a set-up Mac (CI, a fresh clone) there is no cert: Vite serves plain HTTP on localhost, still a secure context.
 * Plain HTTP on the ZeroTier IP would not be one, and the service worker would never register.
 */
const https = existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
const { server: { hosts = [] } = {}, zerotierIp } = existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
/**
 * The first `server.hosts` address that is not loopback (the server's own rule), so the phone reaches the preview where
 * it reaches the Feed. A v1 file that `pnpm start` has not migrated yet still holds it in `zerotierIp`.
 */
const remote: string | undefined =
  hosts.find((host: string) => !(host === "localhost" || host === "::1" || host.startsWith("127."))) ?? zerotierIp;
/**
 * The worktree's server. Its cert is for the ZeroTier IP and localhost, signed by mkcert's CA, which Node doesn't trust,
 * hence `secure: false` on this local hop.
 */
const target = process.env.DOOMLEARN_API ?? "https://127.0.0.1:8443";
const proxy = { "/api": { target, secure: false }, "/clips": { target, secure: false } };
// Vite listens on one address, and 0.0.0.0 would also open the preview to the home Wi-Fi: with a cert it listens on the
// remote address, and the plugin below adds localhost.
const server = { https, proxy, host: https && remote ? remote : "localhost", port: 8444, strictPort: true };

export default defineConfig({
  plugins: [
    {
      name: "preview-on-localhost",
      // A second listener on localhost, with the same cert and app, so the preview serves both addresses.
      configurePreviewServer({ middlewares, httpServer }) {
        if (!(https && remote)) return;
        const local = createServer(https, middlewares).listen(server.port, "localhost");
        httpServer.once("close", () => local.close());
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      injectManifest: { globPatterns: ["**/*.{js,css,html,png}"] },
      manifest: {
        name: "doomlearn",
        short_name: "doomlearn",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0b0f17",
        theme_color: "#0b0f17",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
    }),
  ],
  server,
  preview: server,
});
