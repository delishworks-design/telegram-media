# Persistent backend for Telegram-backed media storage + Watch Together.
# Needs a long-lived process (MTProto session, resumable uploads, Range streaming,
# WebSocket signalling), so it belongs on a normal Node host — not Vercel/serverless.
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Toolchain for the better-sqlite3 native module when no prebuilt is available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Bring over the already-compiled, production-only dependency tree.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
RUN mkdir -p /data/uploads && chown -R node:node /app /data
# Persist these two paths on a volume.
ENV DATABASE_PATH=/data/media.sqlite \
    UPLOAD_TMP_DIR=/data/uploads \
    PORT=8787 \
    HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
