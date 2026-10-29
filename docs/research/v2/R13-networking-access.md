# R13. Networking, access and auth (gap round)

## Question

How should a self-hosted, single-user doomlearn server let its owner reach the PWA from a phone, without tying the project to ZeroTier? For each access mode we need: setup steps, how the phone gets a trusted cert (a service worker needs a secure context), whether the PWA installs, and the exposure. Then: what similar projects do, what minimal auth fits, and the defaults for `server.hosts`, TLS and auth.

Today: `serve()` binds `127.0.0.1` and `config.zerotierIp` on 8443. It uses an mkcert cert from `DOOMLEARN_HOME/tls` and refuses to start without both (`src/server.ts:138-146`). There is no auth (architecture-now §4). The README asks the owner to install the mkcert root CA on the phone and run ZeroTier on both devices (`README.md:20-36`).

$P2 = (session scratchpad). Raw doc pulls are in `$P2/r13/{ts,hono}.txt` (ctx7 `/websites/tailscale`, `/websites/hono_dev`).

## Findings (with evidence)

### F1. The secure-context rule sets the constraints
- A page is a secure context if it is served over `https`, or from `127.0.0.0/8`, `::1` or `localhost`. A plain-http LAN IP is not secure (https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
- So on the Mac, `http://127.0.0.1` is enough for the service worker. A phone always needs HTTPS with a cert it trusts.

### F2. Comparison of access modes

| Mode | Owner setup | Phone cert trust | PWA installs on phone | Exposure |
|---|---|---|---|---|
| (a) localhost only | nothing | n/a (secure by F1) | no, phone cannot reach it | Mac only, but any local web page can still POST to it (R6 F9) |
| (b) LAN IP + mkcert | `mkcert -install`, a cert for the LAN IP, bind the LAN IP | install `rootCA.pem` as a profile, then enable full trust (iOS). Android needs user roots, which Chrome does not trust by default | yes, once the CA is trusted | everyone on the same Wi-Fi. A DHCP IP change breaks the cert and the URL. Phone only works at home |
| (c) Tailscale `serve` | install Tailscale on Mac and phone, enable MagicDNS + HTTPS in the admin console, `tailscale serve --bg 8443` | none: Let's Encrypt cert for `<mac>.<tailnet>.ts.net` | yes, a public CA, so no profile install | tailnet members only. Machine name goes into the public CT log |
| (c') Tailscale `cert` files | as (c), plus `tailscale cert --cert-file … --key-file …` and node serves TLS on the tailnet IP | none (Let's Encrypt) | yes | as (c). Files expire in 90 days and the owner must renew them |
| (d) ZeroTier + mkcert (today) | ZeroTier on both, join a network, mkcert cert for the ZT IP | install the mkcert CA (as b) | yes | ZT network members. Free plan is 10 devices, 1 network |
| (e) Cloudflare Tunnel | `cloudflared`, a named tunnel (a domain on Cloudflare for a stable name) | none (Cloudflare cert) | yes | **the public internet**. Needs real auth (or Cloudflare Access) in front |

Evidence per row:
- (b)/(d) mkcert README: "For the certificates to be trusted on mobile devices, you will have to install the root CA". On iOS, "install the profile in Settings > Profile Downloaded" and then "enable full trust in it". For Android, "you will have to install the CA and then enable user roots in the development build of your app". `rootCA-key.pem` "gives complete power to intercept secure requests from your machine. Do not share it" (https://github.com/FiloSottile/mkcert). For a browser PWA on Android, the last point means the mkcert route is weak there. This is inferred from the README; not tested on a device.
- (c) `tailscale serve 3000` gives `https://my-device.tailnet-name.ts.net/` → `proxy http://127.0.0.1:3000`. It "Requires MagicDNS and HTTPS certificates enabled on the tailnet" (https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-team.md).
- Serve targets can be a port, `localhost:3000`, `https://localhost:8443` (a valid cert) or `https+insecure://…` (self-signed). "Note that only `http://127.0.0.1` is supported for proxies" (https://tailscale.com/docs/reference/tailscale-cli/serve.md, https://tailscale.com/kb/1242/tailscale-serve). So serve can proxy to doomlearn's current HTTPS port, or to a plain-HTTP 127.0.0.1 port.
- `--bg` "runs persistently in the background until you disable it" and comes back after a reboot. On the Mac App Store variant you "can use Serve to share ports but not files or directories" (https://tailscale.com/kb/1242/tailscale-serve). Sharing a port is all we need.
- Serve "adds a few Tailscale identity headers": `Tailscale-User-Login` and `Tailscale-User-Name` (https://tailscale.com/kb/1312/serve).
- HTTPS setup: on the DNS page, enable MagicDNS and then **Enable HTTPS**. You must acknowledge that "machine names … will be published on a public ledger" (Certificate Transparency). "Do not enable the HTTPS feature if any of your machine names contain sensitive information". Certs are Let's Encrypt, 90 days. For `tailscale cert` files "you are responsible for renewing them". The URL must be the full MagicDNS name, not `https://machine-name` (https://tailscale.com/kb/1153/enabling-https). The docs do not say in plain words that serve auto-renews. They say serve will "automatically provision TLS certificates" (kb/1312).
- Free Personal plan: "Up to 6 users", "Unlimited user devices", "Access nearly all of Tailscale's features" (https://tailscale.com/pricing). The pricing page does not list Serve or HTTPS per plan. The owner's own tailnet is the real check (see Open questions).
- (d) ZeroTier Personal: "10 devices, one network", personal non-commercial use. Nothing about TLS certs or DNS names (https://www.zerotier.com/pricing/).
- (e) Cloudflare Tunnel opens "outbound-only connections to Cloudflare's global network", with no public IP needed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). Quick Tunnels "are for testing and development", "have no uptime guarantee" and "do not support Server-Sent Events (SSE)". The hostname changes on every run (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/). No SSE would break any live-status stream v2 adds (R6).

### F3. Prior art
- **Home Assistant**: Nabu Casa cloud is "the easiest and safest option". The second option is a VPN: "A secure way to remotely access your Home Assistant is to use a Virtual Private Network (VPN) service", which names Tailscale and ZeroTier. Then a reverse proxy, and port forwarding with the warning "Just putting a port up is not secure" (https://www.home-assistant.io/docs/configuration/remote/). HA also has its own user accounts.
- **Immich**: the options are WireGuard/OpenVPN, Tailscale (when you cannot open a router port), or a reverse proxy with your own domain. "Never forward port 2283 directly to the internet". It also warns that "the existence of severe security vulnerabilities cannot be ruled out" (https://docs.immich.app/guides/remote-access).
- **Jellyfin**: built-in HTTPS is off by default, and it is "strongly recommended to handle HTTPS termination separately on a reverse proxy". "Self-signed certificates … are strongly discouraged". "You do not have to make your server accessible through the internet" (https://jellyfin.org/docs/general/post-install/networking/).
- **opencode** (`$P2/repos/opencode` @3884062): `opencode serve`/`web` binds `127.0.0.1` by default and takes `--hostname 0.0.0.0` or `--mdns` to open it up (`packages/web/src/content/docs/server.mdx:16-27`, `web.mdx:42-65`). Auth is opt-in HTTP Basic through `OPENCODE_SERVER_PASSWORD` (user `opencode`). "If `OPENCODE_SERVER_PASSWORD` is not set, the server will be unsecured. This is fine for local use but should be set for network access" (`web.mdx:21`, `server.mdx:37-43`). SECURITY.md lists "Server access when opted-in" as out of scope (`SECURITY.md:21-29`). opencode does no TLS itself.
- **orca** (`$P2/repos/orca` @4735ecef), a native mobile app, not a PWA:
  - Pairing is by QR in desktop Settings > Mobile (`mobile/README.md:55-64`).
  - Each paired device gets its own revocable token, `randomBytes(24).toString('hex')` (`src/main/runtime/device-registry.ts:1-4,125`).
  - TLS is a self-signed cert whose fingerprint the app pins from the QR (`src/main/runtime/tls-certificate.ts:1-4`). A browser PWA cannot pin a cert, so this part does not carry over.
  - The bind stays loopback until a LAN pairing offer is made (`runtime-rpc/runtime-rpc-network-exposure.ts:7-11`).
  - It prefers tailnet addresses (100.64.0.0/10) for pairing "because LAN addresses stop working once devices split networks" (`src/shared/tailnet-address.ts`).

Pattern: all five default to local-only, and none puts the app on the internet by default. Remote access goes through a VPN or tailnet first and a reverse proxy second. Auth is either always on (HA, Immich, Jellyfin, which are multi-user) or opt-in for single-owner tools (opencode).

### F4. What Hono gives for auth (hono src at `$P2/repos/hono`)
- `bearerAuth({ token | verifyToken, prefix?, headerName? })` reads one header and compares with `timingSafeEqual` (`src/middleware/bearer-auth/index.ts:9,24-49,157`; https://hono.dev/docs/middleware/builtin/bearer-auth). It reads headers only, never cookies or the query string.
- `basicAuth` (https://hono.dev/docs/middleware/builtin/basic-auth). Only the browser's own auth prompt gives a PWA Basic credentials, and on iOS standalone mode that prompt is awkward. Inferred, not tested.
- Cookie helpers: `setSignedCookie`/`getSignedCookie` with HMAC, plus `__Host-`/`__Secure-` prefixes (https://hono.dev/docs/helpers/cookie, `src/helper/cookie/index.ts:50,130`). Hono throws if `Max-Age` > 400 days (`src/utils/cookie.ts:206-210`). So a "long-lived" cookie means at most 400 days, refreshed on use.
- `csrf()`, `secureHeaders`, `ip-restriction` are also built in (`src/middleware/` listing; R6 F9).

### F5. How auth meets the PWA
- **`<video src>` and Range**: the element makes plain GETs, so code cannot add an `Authorization` header. Same-origin cookies are sent. A bearer token kept in JS would need `?token=` in clip URLs, which leaks into logs and history. The other route is a service worker that rewrites every request, but the SW already slices cached ranges (`web/sw.js:35-44`), so that adds complexity.
- **Offline queue**: queued POSTs replay with `fetch(path, …)` and no explicit `credentials` (`web/app.js:93`). The fetch default is `same-origin`, so a cookie rides along on replay. A header token would have to be added at every fetch site (3 today: `app.js:64,93,305`, plus the upload at `:554`). On a 401 the queue must keep the item and show the pairing screen rather than drop it.
- **iOS storage split**: a home-screen web app does not share cookies or storage with Safari. WebKit calls this by design (https://bugs.webkit.org/show_bug.cgi?id=181849). Copying cookies at install time is disputed (vendor blog only). So a "scan QR → opens Safari → cookie set" flow would log in Safari, not the installed PWA. Pairing has to finish **inside** the installed PWA, for example a "paste or type pairing code" screen it shows on a 401.
- **ITP 7-day cap**: it covers client-side cookies and script-writable storage. Home-screen apps "have their own counter of days of use" and WebKit does "not expect the first-party in such a web application to have its website data deleted" (https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/). The post says nothing on `Set-Cookie` cookies. An HttpOnly server cookie is the safest bet, but it is not proven here.

### F6. "No auth on localhost/tailnet" does not hold
- With `tailscale serve`, every tailnet request reaches doomlearn from `127.0.0.1` (F2 (c)). The bind address no longer tells you who is calling.
- Any web page open on the Mac can send simple POSTs to `https://127.0.0.1:8443` (R6 F9). `csrf()` blocks that for unsafe methods, but GETs (feed data, clips) stay readable through `<video>`/`<img>`.
- A tailnet can hold up to 6 users and shared nodes (pricing). ZeroTier is the same: network members.
- v2 adds config writes and agent runs. R6 already warns that a config write must not become remote code execution (R6 line 169).
- So "network = auth" is acceptable only when the bind and the tailnet are truly single-person. A token costs little and removes the doubt.

## Recommendation for doomlearn v2

1. **README default: Tailscale Serve.** The phone gets a real Let's Encrypt cert with no CA profile, so the PWA installs cleanly on iOS and Android. It works off the home Wi-Fi and is free for this use. Orca, HA and Immich list it (F2 (c), F3). Steps:
   1. Install Tailscale on the Mac and phone and sign in to the same account.
   2. Enable MagicDNS + HTTPS in the admin console, and read the CT-log warning.
   3. Run `tailscale serve --bg <port>`.
   4. Open `https://<mac>.<tailnet>.ts.net` on the phone and add it to the home screen.
   5. Enter the pairing code.
2. **Documented alternatives**, in the README "Other ways to connect" section:
   - LAN or ZeroTier + mkcert (today's path, kept for the owner): needs the CA on the phone, and Android is weak.
   - Localhost only: dev, or watching on the Mac.
   - Cloudflare Tunnel: listed as "exposes to the internet; auth required; not supported". It is out of scope for the docs beyond a warning.
3. **Config shape** (fits R8's Zod sketch):
   ```ts
   server: z.object({
     hosts: z.array(z.string()).default(['127.0.0.1']), // bind list; add a LAN/ZeroTier IP for mkcert mode
     port: z.number().default(8443),
     tls: z.discriminatedUnion('mode', [
       z.object({ mode: z.literal('none') }),                      // plain HTTP: localhost, or behind `tailscale serve`
       z.object({ mode: z.literal('files'), cert: z.string(), key: z.string() }), // mkcert or `tailscale cert` output
     ]).default({ mode: 'none' }),
     auth: z.object({ mode: z.enum(['token', 'none']).default('token') }),
   })
   ```
   - `hosts: ['127.0.0.1']` as the default is right: it matches opencode's default and orca's loopback-first bind (F3). With `tailscale serve` the proxy only supports `http://127.0.0.1` anyway (F2).
   - TLS: use `'none' | 'files'` and not `'mkcert' | 'tailscale' | 'none'`. In Tailscale mode doomlearn does no TLS at all; it is `none` + serve. mkcert and `tailscale cert` both just produce PEM files.
   - A `doctor`/startup check should refuse a non-loopback host with `tls.mode: 'none'`, since a phone on plain-http LAN breaks the SW (F1). It should also warn when `auth.mode: 'none'` is set with a non-loopback host, the same way opencode warns.
   - Old `zerotierIp` migrates to `hosts: ['127.0.0.1', zerotierIp]` plus `tls: { mode: 'files', cert: 'tls/cert.pem', key: 'tls/key.pem' }`. The owner's setup keeps working.
4. **Auth: one secret, cookie session, paired inside the PWA.**
   - First run generates a random token (as orca does, `randomBytes`) and stores it in `DOOMLEARN_HOME` with mode 0600, not in the repo and not in the config the PWA can edit.
   - `doomlearn pair` prints the token, plus a QR of it for desktop-to-phone copy.
   - On a 401 the PWA shows "Enter pairing code". `POST /api/pair {code}` sets an HttpOnly, Secure, SameSite=Strict `__Host-` cookie with `Max-Age` 400 days (the Hono cap) and refreshes it on use.
   - A ~10-line middleware accepts the cookie, or `Authorization: Bearer` for curl/CLI, and compares with `timingSafeEqual`. Hono's `bearerAuth` alone cannot read cookies (F4).
   - This works with `<video src>` Range and the offline queue without touching any fetch call (F5). Keep `csrf()` from R6.
   - Rotating the token (`doomlearn pair --rotate`) logs out every device. That is enough for one owner.
   - `auth.mode: 'none'` is for tests and localhost dev only.
5. **Out of scope**: multi-user and accounts, per-device tokens and a device list (orca-style), OAuth, Tailscale identity-header auth, managing Tailscale/cloudflared from doomlearn, cert renewal automation, public internet exposure, and mDNS discovery.

## Open questions for the owner

1. Switch your own setup to Tailscale (the README default), or keep ZeroTier + mkcert as your personal mode? Is publishing `<mac-name>.<tailnet>.ts.net` to the CT log acceptable?
2. Is a single shared token (rotate = log out all) enough, or do you want per-device tokens you can revoke one at a time (orca style, more code)?
3. Should doomlearn check or print the `tailscale serve` command in `doctor`, or only document it in the README?
4. Needs a device test (not verified here): does `tailscale serve` renew the cert on its own after 90 days? Does an iOS home-screen PWA keep a 400-day HttpOnly cookie across weeks without use?
5. Should the `/api/pair` route be rate-limited (Hono has no built-in limiter)? The token is long and random, so a simple lockout after N failures may be enough.
