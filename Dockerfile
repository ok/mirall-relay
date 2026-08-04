# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------
# Kept separate so the runtime image never carries npm's cache or dev deps.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
COPY scripts ./scripts

# ---- runtime -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MIRALL_RELAY_SEED_FILE=/data/seed \
    MIRALL_RELAY_ADMIN_HOST=0.0.0.0 \
    MIRALL_RELAY_ADMIN_PORT=9200 \
    MIRALL_RELAY_PORT=49737

# Non-root, with a data directory for the one piece of durable state we have.
RUN useradd --system --uid 10001 --create-home --home-dir /app relay \
 && mkdir -p /data \
 && chown -R relay:relay /app /data

WORKDIR /app
COPY --from=build --chown=relay:relay /app /app
COPY --chown=relay:relay docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER relay

# The seed lives here. MOUNT THIS, or the relay mints a new identity on every
# container replacement and every client configured with the old key is stranded.
VOLUME ["/data"]

# DHT traffic is UDP and must be reachable from the internet for hole-punching.
EXPOSE 49737/udp
# Admin/metrics. Inside the container it binds 0.0.0.0 so a sidecar can scrape it;
# publish it ONLY to localhost or a private network — never to the internet.
EXPOSE 9200/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MIRALL_RELAY_ADMIN_PORT||9200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "bin/mirall-relay.js"]
