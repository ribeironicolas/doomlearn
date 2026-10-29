# Security

## Reporting a vulnerability

Report it privately: open the repository's **Security** tab and click **Report a vulnerability** (GitHub's private vulnerability reporting). Please do not open a public issue, pull request or discussion for it.

## What doomlearn is, and what it is not

doomlearn is self-hosted: one person runs it on their own Mac for their own phone. There is no hosted service and no account system, and the project offers no way to run it safely for anyone else.

- **Never expose it to the internet.** No port forwarding, no reverse proxy, no tunnel that a stranger can reach. The server has no login.
- **The ZeroTier network is the authentication.** The server listens only on the addresses in `server.hosts` (`127.0.0.1`, plus the Mac's ZeroTier address for the phone). Anyone who can reach those addresses can use doomlearn, so keep the ZeroTier network to your own devices.
- **Any web page open on the Mac can GET your Clips.** A page in any browser tab can load `127.0.0.1:8443/clips/…` (or the ZeroTier address) as a video. Treat your Clips as readable by whatever you browse on that Mac.

## In scope

- A way for someone outside your ZeroTier network to reach the server or the data folder.
- Code execution, file reads or writes outside the data folder triggered by a Source, a request to the server or a value in `config.json`.
- doomlearn leaking your Claude Code or Codex login.

## Out of scope

- Anything that needs the server exposed to the internet, or a ZeroTier network shared with people you do not trust.
- Access by other users or pages on the same Mac, as described above.
- Vulnerabilities in Claude Code, Codex, ZeroTier, mkcert, Calibre or other tools doomlearn runs: report those to their own projects.
