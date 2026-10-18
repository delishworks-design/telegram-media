# Deploy (Docker + Caddy, HTTPS, always-on)

Turns the app into a permanent service two phones can reach over the internet, with a real
TLS certificate so the Watch Together camera/mic works. Target: any small Linux VPS (1 vCPU /
1 GB is plenty).

## What you need

- A VPS running Debian/Ubuntu with root (or sudo) access, **ports 80 and 443 open**.
- A domain (or subdomain) you can point at the VPS.
- Docker with the Compose plugin (`docker compose version`).

## 1. DNS

Create an **A** record (and **AAAA** if the VPS has IPv6) for e.g. `media.example.com`
pointing at the VPS IP. Wait for it to resolve:

```bash
dig +short media.example.com
```

## 2. Install Docker (skip if present)

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code onto the server

Copy the project (excluding `node_modules`, `data`, `.env`) from wherever you have it:

```bash
rsync -av --exclude node_modules --exclude dist --exclude data --exclude .env \
  ./telegram-media/ user@your-vps:/opt/telegram-media/
```

(If you keep it in git, `git clone` on the server instead. Never commit `.env`.)

## 4. Configure `.env`

```bash
cd /opt/telegram-media
cp .env.production.example .env
```

Generate the two secrets and paste them in:

```bash
node -e "console.log('MASTER_KEY='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('PLAYBACK_TOKEN_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
```

Generate a password hash per user (run twice, once per username; or use `pnpm hash-password`
on any machine):

```bash
node -e "import('./dist/util/crypto.js').then(m=>console.log(m.hashPassword(process.argv[1])))" 'your-password'
```

Then set, at minimum:

- `DOMAIN`, `EMAIL`
- `PUBLIC_BASE_URL=https://<domain>` (matching `DOMAIN`)
- `MASTER_KEY`, `PLAYBACK_TOKEN_SECRET`
- `AUTH_USERS=[{"username":"owner","passwordHash":"..."},{"username":"partner","passwordHash":"..."}]`

Leave `TELEGRAM_API_ID`/`HASH` blank if you prefer the in-browser wizard, or fill them here.

## 5. Telegram session

Two options:

- **Fresh login on the server (simplest).** Leave Telegram blank and complete the wizard at
  `https://<domain>` after the stack is up (API id/hash → phone → code → channel).
- **Reuse the session that already exists on your phone.** Copy the database and keep the
  **same `MASTER_KEY`** — otherwise the encrypted session cannot be decrypted:

  ```bash
  scp ./telegram-media/data/media.sqlite user@your-vps:/tmp/media.sqlite
  docker volume create telegram-media_media-data
  docker run --rm -v telegram-media_media-data:/data -v /tmp:/in alpine \
    sh -c "cp /in/media.sqlite /data/media.sqlite && chown -R 1000:1000 /data"
  ```

  (Or just run `docker compose up -d`, then copy the file into the running container's
  volume and restart the `app` service.)

## 6. Bring it up

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Caddy requests the certificate on first request; give it a few seconds. Then open
`https://<domain>` — you should get the Media Vault login.

## 7. Verify

```bash
curl -s https://<domain>/healthz           # {"ok":true,...}
```

- Sign in, upload a short video, confirm it appears.
- Open `https://<domain>/watch.html`, start a room, and confirm *Join call* asks for
  camera/mic (TLS makes this work on any network).

## Updating

```bash
cd /opt/telegram-media
git pull            # or rsync the new files
docker compose up -d --build
```

## Backups

Everything persistent is in the `media-data` volume (SQLite metadata; the videos themselves
live in Telegram). Back it up with:

```bash
docker run --rm -v telegram-media_media-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/media-data-$(date +%F).tar.gz -C /data .
```

Keep `MASTER_KEY` safe with the backup — the same key is required to read the session.

## Alternative: diskless host (Postgres, no volume)

Some free always-on hosts (e.g. **Northflank free tier**) give you a long-running container
*and* a managed database, but **no persistent disk**. On those, point the app at Postgres
instead of SQLite — the app is the same, only the storage backend changes.

1. Create the service from this repo (it builds with the included `Dockerfile`).
2. Provision the host's managed **PostgreSQL** and copy its connection string.
3. Set these environment variables:

   ```
   DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
   PUBLIC_BASE_URL=https://<your-app-host>
   COOKIE_SECURE=true
   MASTER_KEY=<32-byte base64>
   PLAYBACK_TOKEN_SECRET=<32-byte base64>
   AUTH_USERS=[{"username":"owner","passwordHash":"..."},{"username":"partner","passwordHash":"..."}]
   ```

   `DATABASE_URL` overrides `DATABASE_PATH`; `UPLOAD_TMP_DIR` can stay on the ephemeral disk
   (uploads are streamed straight to Telegram and deleted afterwards). `DATABASE_SSL` is
   optional (`require`/`disable`); it defaults to `require` for non-local hosts.

4. Expose the container's HTTP port and make sure the host forwards **WebSocket upgrades**
   (Watch Together needs them — keep the tunnel/proxy in Full-strict mode with WS enabled).
5. Verify `GET /healthz` returns `{"ok":true}` and the library loads after login.

The schema is created automatically on first boot (same migrations as SQLite). Switching
between SQLite and Postgres needs no code change and no data migration beyond re-running the
Telegram login (or restoring the `telegram_session` row).

## Troubleshooting

- **Certificate never issues.** DNS not pointing here yet, or ports 80/443 blocked by the
  VPS firewall / cloud security group. Let's Encrypt needs port 80 reachable at least once.
- **Login works but Watch Together never connects.** Something in front of Caddy is not
  forwarding WebSocket upgrades. Caddy itself does; if you add Cloudflare, keep it in
  "Full (strict)" and leave WebSockets enabled.
- **Camera/mic still blocked.** You must use the `https://` URL, not an IP or `http://`.
- **`better-sqlite3` build fails.** The image installs a toolchain already; if a mirror is
  unreachable, rebuild with a network that can reach the Debian/pnpm registries.
