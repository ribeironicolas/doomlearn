# Operating doomlearn

How to run your own instance once it is installed (see the [README](../README.md) for the first install).

## Start and stop

- Start: `pnpm start` from the repo root. It first runs `pnpm preflight`, which prints each missing prerequisite with its install hint; only an old Node or a non-loopback host without a cert stops the start. Then it builds the PWA (`apps/web/dist`, a few seconds), then runs the server, which forks the worker as its own process, and prints the data folder and the Feed URL. It never installs anything: if a media tool's environment or weights are not ready, it logs `worker blocked: tts environment outdated: run \`pnpm bootstrap\`` (or similar), the Feed keeps serving and the worker starts no stage. Run `pnpm bootstrap`, then restart. It also checks the login of each Provider (`claude`, `codex`) that `agents.stages` uses, at start and after every `config.json` change: logged out, it logs `worker blocked: codex not logged in: run \`codex login\`` (or the `claude` equivalent) and the worker starts no stage. Log in, then restart doomlearn or save `config.json` to check again. An unknown Codex model or Effort is only a `warning:` line.
- After a pull, run `pnpm install`, then `pnpm start`. pnpm never installs on its own: with a missing or stale `node_modules`, `pnpm start` stops with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`.
- Keep a log while it runs in the background: `pnpm start > ~/doomlearn/server.log 2>&1 &`.
- Stop: Ctrl+C in its terminal. The first one prints `stopping after current stage (scene, <Source>)`: the running stage (an agent call can take minutes) finishes, no new one starts, and the Feed keeps serving until the worker exits. A second Ctrl+C stops now, killing any running agent call. In the background, `pkill -INT -f 'node apps/server/src/main.ts'` is the first Ctrl+C. Clips already buffered on the phone keep playing while it is stopped.
- A crashed worker is restarted after 30 s, at most 3 times an hour; then it stays down, with the reason and restart count in `pnpm doomlearn status`, until you restart doomlearn. The server keeps serving the Feed either way.

## Logs

doomlearn writes to stdout and stderr only, so the log is wherever you redirected them (`server.log` above). Why a job got stuck is also in the database: `pnpm doomlearn status` prints each stuck chapter with its last error.

## The data folder

Everything lives in `~/doomlearn`, or in `$DOOMLEARN_HOME` when it is set:

| Path | What it holds |
| --- | --- |
| `config.json` | Your settings: only the keys you changed (keys in `config.schema.json`, copied next to it) |
| `config.v1.json.bak` | Your v1 `config.json`, kept when it was rewritten to the v2 shape |
| `lexicon.json` | The pt-BR Lexicon, the Respellings the narration says: seeded from the repo's `packages/core/lexicon.default.json`, topped up with its new terms, and where the worker adds terms. Yours win, also over a script's own Respelling. The phone's fix sheet saves its fixes in the Lexicon of the Clip's Language. The worker reads it again at every narration, so an edit reaches the next Clip without a restart |
| `lexicon.en.json`, `lexicon.es.json` | The English and Spanish Lexicons, the same way. They start empty (`packages/core/lexicon.en.default.json`, `lexicon.es.default.json`) |
| `previews/<id>.wav` | A sentence the worker spoke for the phone's fix sheet. It is deleted when the phone fetches it, or after 1 h |
| `doomlearn.db` (+ `-wal`, `-shm`) | The SQLite database |
| `doomlearn.db.pre-<migration>.bak` | A copy of the database taken just before an upgrade's migrations changed it, one per upgrade, all kept (see Restore after an upgrade) |
| `codex-home/` | The `CODEX_HOME` doomlearn runs `codex` under, so your global `AGENTS.md`, skills and config stay out of Clip prompts. Its `auth.json` is a link to your `~/.codex/auth.json`, never a copy. Present once a stage uses Codex |
| `prompts/<language>/` | Each stage's system prompt written for a Language, as the agent CLIs read it. Each is written again on its first use after the worker starts; do not edit |
| `sources/<id>/` | Each Source's original file and its converted chapters |
| `jobs/<id>/` | One folder per generation job: the agent outputs, narration, scene and render files |
| `clips/` | The finished Clips, `<conceptId>-<angle>-<jobId>.mp4`. A Clip made before Clips had a Language keeps its `<conceptId>-<angle>.mp4` |
| `tls/cert.pem`, `tls/key.pem` | The mkcert certificate the server uses |

Back up before you change anything here by hand. Stop the server, then copy the database with `sqlite3 ~/doomlearn/doomlearn.db "VACUUM INTO '/path/to/backup.db'"`.

## Restore after an upgrade

Before an upgrade's migrations touch a database that holds data, `pnpm start` copies it to `doomlearn.db.pre-<migration>.bak`. After a migration the previous version may not run on the database (see each migration's section below), so the sure way back is restoring that copy:

1. Stop doomlearn (see Start and stop).
2. Put the copy back, dropping the newer WAL so it is not replayed onto it: `cd ~/doomlearn && rm -f doomlearn.db-wal doomlearn.db-shm && cp doomlearn.db.pre-<migration>.bak doomlearn.db`.
3. If you are going back to v1 and `config.v1.json.bak` exists, restore it: `cp config.v1.json.bak config.json`.
4. If `config.json` has a `worker.language` key, remove it when the version you go back to has no Language of new Clips setting. That version refuses a `config.json` with a key it does not know, and does not start.
5. Check out the previous version in the repo (`git checkout <tag or commit>`), run `pnpm install`, then start it.

Clips, Sources and the lexicon are files the upgrade does not change, so they need no restore.

### Going back from the clip_language migration

The `20261015232815_clip_language` migration gives every Clip a Language. It rebuilds the `clips` table, so it cannot be undone in place. To undo it, restore `doomlearn.db.pre-20261015232815_clip_language.bak` as above. The restored database has no Clip, event or job made after the upgrade. Their mp4 files stay in `clips/`.

Unlike the general case above, the previous version also starts on this migrated database without a restore, because the migrator ignores the migrations it does not know. Its Clips get the `pt-BR` default.

The previous version has no plan for a Translation ("Make in <Language>"). If it picks a queued or running `translate` job, its worker fails on each tick and runs no other job. Before you start it on this database, stop doomlearn and set those jobs to done. Set stuck ones to done too, so that ↻ Retry does not queue them again:

```sh
sqlite3 ~/doomlearn/doomlearn.db "UPDATE jobs SET status='done' WHERE kind='translate' AND status IN ('queued', 'running', 'stuck')"
```

Those Translations are not made. After you upgrade again, ask for them again from the 🌐 sheet.

A Regenerate the previous version queues has no Language, and this version does not find its Clip. Before upgrading again, stop doomlearn and give those jobs the `pt-BR` Language: `sqlite3 ~/doomlearn/doomlearn.db "UPDATE jobs SET language='pt-BR' WHERE kind='regenerate' AND language IS NULL"`.

## Status CLI

```sh
pnpm doomlearn status                  # chapters extracted and Concepts per Source, stuck chapters, the running, queued and stuck jobs, the buffer, today's Clips, the Worker status and every Blocker
pnpm doomlearn stats                   # Agent usage per Provider, stage, day, Source and Clip; --by <one>, --provider claude|codex
pnpm doomlearn retry <jobId>           # requeue a stuck job
pnpm doomlearn pause <sourceId>        # stop new Clips from a Source; resume <sourceId> undoes it
```

`pnpm doomlearn` lists every command.

`GET /api/usage?by=provider|stage|day|source|clip` (optionally `&provider=claude|codex`) returns each Provider's Usage windows (newest reading per window, its age, and why it is `unavailable` when it is), the same agent usage as `stats`, and past rate-limit pauses. Claude windows come with every Claude call; Codex windows from a probe after every Codex call and on each request (at most 3 s), only when a stage uses Codex.

`GET /api/status` returns the same Worker status: `running` (with the job, stage and its start time), `idle`, `stopping` or `stopped`, the job counts by status, and every active Blocker (stopped, stopping, preflight, invalid config, Worker pause, outside the Run windows, rate limit, usage threshold) with its reason and until-time. `GET /api/config` returns the config and its version (the file's mtime); `PUT /api/config` with that version and a `worker` and/or `agents` section saves it, or answers 409 "config changed on disk, reload" when the file changed since, and 409 naming the problem while `config.json` is invalid on disk. Each section sent replaces the saved one whole: a key it leaves out goes back to its default, so send the whole section. `server.*` is edited in the file only.

`worker.stopAtUsagePercent` in `config.json`, e.g. `{"worker": {"stopAtUsagePercent": {"fiveHour": 90, "sevenDay": 80}}}`, stops the worker from starting stages once the newest Claude reading of that window is at or above it, until the window resets. Off by default. Usage that is unknown, status-only or past its reset never stops it, and a reading lags one call, so it stops within about one stage of the threshold.

## config.json

`config.json` in the data folder holds only the keys you changed; everything else is a default. Editors autocomplete it from `config.schema.json`, copied next to it, which describes every key: the agent per stage (`agents.*`), pacing, Worker pause and Run windows (`worker.*`), and the hosts and port (`server.*`, read at start). The PWA's ⚙️ screen edits `worker.*` and `agents.*`. An unknown key is an error: `pnpm start` refuses it, and a running server keeps the last good config and logs the problem. Edits apply within seconds without a restart, except `server.*`.

## Billing

doomlearn calls `claude -p` on your Claude Code login, so it uses your subscription. If `ANTHROPIC_API_KEY` is set in the environment `pnpm start` runs in, `claude -p` always uses that key instead, and every call is billed to the API. A stage set to `codex` (`agents.stages.<stage>.provider`) runs `codex exec` on your Codex login the same way; `codex login` with an API key bills the API instead.

## Phone access

The phone reaches the Mac over a ZeroTier network, over HTTPS with a certificate from mkcert.

1. Join the Mac and the phone to the same ZeroTier network.
2. Find the Mac's ZeroTier IP: `zerotier-cli listnetworks` (the last column holds the assigned address, e.g. `10.x.y.z/16`; use the address without the `/16`).
3. Add it to `server.hosts` in `config.json`: `{"server": {"hosts": ["127.0.0.1", "<zerotier-ip>"]}}`. The server listens only on those addresses. Without a cert it serves plain HTTP on `127.0.0.1` only, and with a non-loopback host it refuses to start until the cert exists.
4. Make the certificate: `mkcert -install` once, then the `mkdir … && mkcert …` command `pnpm start` prints. Rerun it if the ZeroTier IP changes.
5. Install the mkcert root CA on the phone. It is `rootCA.pem` in the folder `mkcert -CAROOT` prints.
   - Android: Settings › Security › Encryption & credentials › Install a certificate › CA certificate (menu names vary by vendor).
   - iPhone: AirDrop it, install the profile in Settings, then turn on full trust in Settings › General › About › Certificate Trust Settings.
6. Open `https://<zerotier-ip>:8443` on the phone and add it to the home screen.

The default port is 8443 (`server.port` in `config.json`). macOS refuses ports below 1024 without root, so 443 fails with `EACCES`.

If the phone connects but HTTPS hangs while a small plain-HTTP page loads, large packets from the phone are being dropped inside the tunnel. Set the network's MTU to 1280 in ZeroTier Central, then turn the network off and on in the phone's ZeroTier app.

## Previewing the React app on its own origin

The server serves the built React app at its own origin, under the same `/sw.js` as the v1 app it replaced, so an installed v1 app picks it up through the "New version · Reload" toast. To try a change on the phone without deploying it, run `pnpm --filter @doomlearn/web preview` with the server running. It builds the app and serves it on `https://<zerotier-ip>:8444` with the same mkcert cert, proxying `/api` and `/clips` to the server (`https://127.0.0.1:8443`; set `DOOMLEARN_API` to point elsewhere). It is a separate origin, so the installed app's press queue and caches are never touched. It listens on the first address in `server.hosts` that is not loopback (your ZeroTier IP), and on `localhost` (`https://localhost:8444` on the Mac). It never listens on every address, so the home Wi-Fi can't reach it. A v1 `config.json` that `pnpm start` has not rewritten yet gives the address in `zerotierIp`. Off a set-up Mac (no cert in the data folder, or only loopback hosts) it serves plain HTTP on `localhost:8444` instead. Stop it when you leave (see Review pages).

The proxy's hop to the server skips certificate checks (`secure: false`): Node does not trust mkcert's CA, so without it the proxy fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` would work too.

## Install quirks

- macOS has no `timeout` command. Use `gtimeout` (`brew install coreutils`) or `perl -e 'alarm shift; exec @ARGV' <seconds> <command>`.
- The pt-BR Chatterbox voice is not on PyPI. `packages/media/python/tts/vendor/chatterbox` is the loader vendored from Resemble's Hugging Face Space, and it shadows the pip package, which is pinned to torch 2.6.
- Calibre is a cask: `brew install --cask calibre`. It provides `ebook-convert`, which ebook Sources need.

## Review pages

When an agent serves something for you to look at (a preview server, a prototype, a probe page) on an address the phone or the network can reach, take it down when you leave. Only the doomlearn server itself stays up.
