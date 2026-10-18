# Telegram Media Vault + Watch Together

A standalone, persistent service that:

- stores your videos in **your own Telegram account over MTProto** (the client API, not the
  Bot API),
- serves them back through **authenticated HTTP Range streaming**,
- gives you a **media-library UI** (upload, search, rename, delete),
- and runs **Watch Together rooms** — synchronized playback plus WebRTC audio/video calls —
  on the same server.

One process, one login, one deploy.

---

## Read this first: where this came from

You asked for this to be built **into an existing Watch Together website**. That app is
**not present in this workspace** — the only project here is `selah` (a calling-card app
with no rooms, player, WebRTC or Realtime). There was nothing to integrate with.

You then said to make the app too. So this repo now **is** the Watch Together app: the
library, the rooms, the synced player and the call are all here. Room signalling is
**self-hosted over WebSocket** rather than Supabase Realtime, because there is no Supabase
project or credentials here — and a WebSocket signalling channel is the more reliable
choice for WebRTC anyway. The old "embed a signed URL into your own room" contract is kept
below if you ever want to bolt this onto a different frontend.

---

## Architecture

```
browser  ──cookie session──►  Express API        ──► SQLite or Postgres (metadata only)
   │                            auth · telegram setup · uploads (resumable)
   │                            media CRUD · streaming (HTTP 206) · signed tokens
   │
   └──WebSocket /ws?room=CODE──► Realtime        ──► RoomManager (in-memory)
                                 join/leave · playback state · WebRTC signalling
                                        │
                                        ▼
                                 TelegramService ──► teleproto (MTProto) ──► private channel
```

- **Secrets never reach the browser.** The MTProto session string and API hash are
  AES-256-GCM encrypted at rest; the browser only ever sees booleans and filenames.
- **No video binaries in any database.** Only metadata lives in SQLite or Postgres (see
  `DATABASE_URL`). The bytes live in a Telegram channel you own.
- **MTProto, not the Bot API.** Bots cannot read arbitrary history or stream your own files;
  a user session can. Uses the actively maintained `teleproto` fork of GramJS.
- **Self-hosted signalling.** The server relays WebRTC offers/answers/ICE and owns the
  authoritative playback clock. No third-party signalling service.

## Requirements

- Node 20.6+ (uses `node --import` and the built-in test runner).
- A Telegram account, and an API ID / hash from <https://my.telegram.org> → *API development tools*.
- A persistent host (VPS, Fly/Render/Railway, Docker, a home server). **Not Vercel** — see
  [Deployment](#deployment).
- HTTPS for the Watch Together call (browsers require a secure context for camera/mic).

## Quick start

```bash
pnpm install
cp .env.example .env

# 1. Two random 32-byte keys (encrypt session; sign playback tokens)
node -e "console.log('MASTER_KEY='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('PLAYBACK_TOKEN_SECRET='+require('crypto').randomBytes(32).toString('base64'))"

# 2. A password hash for each of the two users, then paste into AUTH_USERS
pnpm hash-password

# 3. Fill .env, then connect Telegram (writes an encrypted session):
pnpm telegram-login        # phone → code → optional 2FA → channel

# 4. Run
pnpm dev                   # http://localhost:8787
```

The same Telegram setup can be done entirely through the browser wizard after first login.

### Telegram credentials & account login

1. Go to <https://my.telegram.org> → **API development tools**, create an app, copy the
   **api_id** and **api_hash**.
2. Either put them in `.env` (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`) or enter them in the
   setup wizard / `pnpm telegram-login`.
3. Choose a storage channel: leave it blank to have the service **create a new private
   broadcast channel**, or give the `@username` of a channel you own.
4. Enter the login code and, if enabled, your two-step (2FA) password. The resulting
   session is encrypted with `MASTER_KEY` before it is written to the database.

`MASTER_KEY` must stay stable — rotating it invalidates the stored session and you will
re-authenticate.

## Using it

1. **Sign in** at `/` (the library). First run shows the Telegram wizard.
2. **Upload** videos — drag-and-drop or the file picker. Large files upload in resumable
   chunks with a live queue; closed tabs resume.
3. **Watch Together** — from a card press *Play in Watch Together* (opens a room with that
   file), or go to `/watch.html` to pick a file, start an empty room, or join by code.
4. **In the room** — share the `/watch.html?room=CODE` link with the other person. Whoever
   presses play/pause/seeks, both stay in sync (server-timed, drift-corrected). Press
   *Join call* for camera/mic; remote video appears as tiles.
5. **Load file** swaps what the room is watching, for everyone.

## Environment variables

See [`.env.example`](./.env.example) for the full list with placeholders. The required ones:

| Variable | Purpose |
| --- | --- |
| `MASTER_KEY` | 32-byte base64 key; encrypts the session + api hash at rest. |
| `PLAYBACK_TOKEN_SECRET` | 32-byte base64 HMAC key for signed playback URLs. |
| `AUTH_USERS` | JSON array of `{username,passwordHash}`. Exactly your two users. |
| `PUBLIC_BASE_URL` / `COOKIE_SECURE` | Origin and cookie security behind HTTPS. |
| `DATABASE_PATH` / `UPLOAD_TMP_DIR` | Persistent paths for metadata and in-flight chunks (local/VM). |
| `DATABASE_URL` | Postgres URL. When set, overrides `DATABASE_PATH` — use on diskless hosts. |
| `MAX_UPLOAD_BYTES` / `CHUNK_SIZE_BYTES` | Upload limits and resumable chunk size. |

There are **no default passwords** and **no committed secrets**; `.gitignore` excludes
`.env`, `data/`, `tmp/`, `*.session` and SQLite files.

## API

All routes are same-origin and require a session cookie unless noted.

**Auth** — `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/logout-all`,
`GET /api/auth/me`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`.

**Telegram setup** — `GET /api/telegram/status`, `POST /api/telegram/login/start`,
`POST /api/telegram/login/code`, `POST /api/telegram/login/password`,
`POST /api/telegram/channel`, `POST /api/telegram/logout`.

**Uploads (resumable)** — `POST /api/uploads` → `{id, chunkSize, expectedChunks}`;
`PUT /api/uploads/:id/chunk/:index` (`application/octet-stream` body);
`POST /api/uploads/:id/complete`; `GET /api/uploads/:id`; `DELETE /api/uploads/:id`;
`POST /api/uploads/:id/retry`; `GET /api/uploads/events` (SSE progress).

**Library** — `GET /api/media?q=&category=&sort=&limit=&offset=`, `GET /api/media/:id`,
`PATCH /api/media/:id`, `DELETE /api/media/:id[?telegram=false]`,
`POST /api/media/:id/playback-token`.

**Rooms** — `POST /api/rooms` (`{mediaId?}` creates and optionally loads), `GET /api/rooms`,
`GET /api/rooms/:id`.

**Streaming** — `GET|HEAD /api/media/:id/stream` — session cookie **or** `?token=` signed
playback token. Supports `Range` → `206 Partial Content`, `416` for bad ranges, `HEAD`,
and `ETag`/`304`.

### Realtime protocol (`/ws?room=CODE`)

Authenticated by the session cookie during the WebSocket upgrade; unauthenticated upgrades
are rejected with `401`. Messages are JSON.

Client → server: `join {room}` · `leave` · `media {mediaId}` ·
`playback {isPlaying?, position?}` · `signal {to, data}` · `ping`.

Server → client: `welcome {selfId, room, members, playback, serverTime}` ·
`peer:join` · `peer:leave` · `media` · `playback {playback, by}` · `signal {from, data}` ·
`error` · `pong`.

`playback` carries an authoritative `{position, updatedAt, isPlaying, seq}`; clients compute
the live position from `serverTime` (clock-offset corrected) and only hard-seek when drift
exceeds ~0.75s. `seq` lets clients ignore stale updates. `signal` messages are relayed only
to the addressed peer.

### Deleting media

`DELETE /api/media/:id?telegram=true` (default) **permanently deletes the file from your
Telegram channel** (the message is revoked) and removes the library row.
`?telegram=false` removes only the local row and keeps the Telegram file. The UI offers
both and the response carries an `explanation` string.

## Embedding in another frontend (optional)

If you want to drive this library from a different Watch Together app instead, two paths:

1. **Signed URL.** Call `POST /api/media/:id/playback-token` (optionally with
   `{ "room": "<roomId>" }`), then load `response.url` into your player. It is absolute,
   cookie-free, expiring, and bound to one media id.
2. **Embedded library.** When the library page is framed, **Play in Watch Together** posts
   `{ type: "watch-together:load-media", media, roomId, roomUrl }` to the parent window.

## Tests

```bash
pnpm test        # node:test, no network, no credentials (FakeStore stands in for Telegram)
pnpm typecheck
pnpm build
```

Results (this workspace, aarch64 / Node 20.19):

```
# tests 58   # pass 58   # fail 0
```

Covered: authentication (login, wrong password, unknown user, cookie flags, logout,
logout-all, session revocation, unauthenticated 401s); resumable uploads (create, chunk,
out-of-order chunks, incomplete finalize → 400, out-of-range chunk → 416, cancel, size
limit → 413); media access control (list/search/category, rename, 404s, delete with and
without Telegram deletion); HTTP range streaming (200, 206 with correct `Content-Range`,
suffix ranges, 416, HEAD, ETag/304); signed playback tokens (cookie-free 206, cross-file
token rejected); the room manager (create/join/leave, empty-room sweep, media reset,
sequence + position clamping, clock-driven position); and the realtime layer over a real
WebSocket (unauthenticated upgrade rejected, welcome payload, peer join/leave, playback and
media broadcast, late-joiner state, targeted signalling relay, rooms REST API); and the
Postgres driver (placeholder translation, migrations, sessions/media/config round-trips via
`pg-mem`). A compiled-server smoke test (spawn `dist/index.js`, log in, fetch `/watch.html`,
create a room, complete a WebSocket handshake, reject a bad cookie) also passes.

## Deployment

**Run this as a long-lived Node process. Do not deploy it to Vercel serverless** — the
MTProto session, multi-minute uploads, byte-range streaming and the WebSocket signalling all
need a persistent process and connection.

The recommended setup is the **Docker Compose + Caddy** stack in this repo: the app plus a
Caddy reverse proxy that obtains a Let's Encrypt certificate automatically (so the Watch
Together camera/mic works). Step-by-step instructions are in **[DEPLOY.md](./DEPLOY.md)**.

```bash
cp .env.production.example .env      # set DOMAIN, EMAIL, keys, AUTH_USERS
docker compose up -d --build
```

That brings up:

- `app` — the service, data on the `media-data` volume at `/data`.
- `caddy` — TLS termination and reverse proxy (`Caddyfile`), forwarding WebSocket upgrades
  for `/ws` automatically.

`PUBLIC_BASE_URL` must equal `https://$DOMAIN` and `COOKIE_SECURE=true`.

### Manual / bare Node (alternative)

```bash
node dist/index.js        # behind your own reverse proxy
```

Front it with a proxy terminating TLS, set `PUBLIC_BASE_URL` to the HTTPS origin and
`COOKIE_SECURE=true`. The proxy **must forward the WebSocket upgrade** for `/ws` (Caddy does
this automatically; with nginx add `proxy_set_header Upgrade $http_upgrade;` and
`proxy_set_header Connection "upgrade";`). Keep `TRUST_PROXY=1` when a proxy is in front.

## Security model

- Credentials and the MTProto session are encrypted with `MASTER_KEY` and never returned by
  any endpoint; logs redact keys matching `pass|secret|token|hash|otp|code|session|key`.
- Login is rate-limited (10 / 15 min / IP); Telegram code entry is rate-limited too.
- Sessions are opaque tokens stored only as SHA-256 hashes, revocable individually or all at
  once; cookies are `HttpOnly`, `SameSite=Strict`, `Secure` when configured.
- The WebSocket handshake reuses the same session cookie and rejects unknown sessions.
- Streaming is private by default: no raw Telegram links are ever exposed; playback needs a
  session or a short-lived signed token.
- Teleproto auto-waits on Telegram `FLOOD_WAIT`; the upload queue additionally backs off and
  retries, and refreshes expired file references before failing a stream.

## Remaining limitations

1. **Not deployed by me.** I have no credentials or host access here; deployment steps are
   above. "Deployed and tested" only describes the local compiled smoke test.
2. **WebRTC uses public STUN only.** On symmetric NATs / restrictive networks the call may
   fail to connect. Add a TURN server via the `wt.turn` localStorage key (JSON
   `{urls,username,credential}`) or wire one into `ICE_SERVERS` in `public/watch.js`.
   Playback sync is unaffected — it runs over the WebSocket, not WebRTC.
3. **Rooms are in-memory.** Restarting the process drops active rooms (clients reconnect and
   re-create them). Playback position is not persisted between sessions.
4. **Mesh calls.** Every participant connects to every other; fine for two, heavier beyond
   ~4. There is no SFU.
5. **No ffprobe.** `duration`/`width`/`height` are unknown unless a client sends them, so
   Telegram's inline preview may be generic. Streaming and seeking are unaffected.
6. **Channel resolution.** Creating a private channel or resolving an `@username` works out
   of the box; resolving a *private* channel by bare numeric id depends on it already being
   in the account's peer cache. Prefer "create" or a username.
7. **No server-side thumbnails**; the UI uses the browser's own video frame.
8. **Format support is the browser's, not ours.** If the browser cannot decode a codec, the
   player shows a clear message and an Open/download fallback. We stream bytes; we do not
   transcode.
9. **Single-node.** Sessions, the upload queue, rooms and rate limits are per-process.
   SQLite (or a single Postgres) is fine for two users; there is no clustering.
