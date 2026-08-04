# No `# syntax=` directive on purpose: this Dockerfile uses only classic
# instructions, and pinning a BuildKit frontend makes every build fetch it from
# Docker Hub first — an avoidable network dependency that fails behind a
# restrictive network or a cold registry.

# ---- build -------------------------------------------------------------
# Kept separate so the runtime image never carries npm, its cache, or dev deps.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY src ./src
COPY scripts ./scripts

# Keep only the prebuilt addons for the architecture being built. The Holepunch
# native modules ship binaries for 13 platforms (~26 MB); twelve of them are dead
# weight in a Linux container image.
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) keep=linux-x64 ;; \
      arm64) keep=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    find node_modules -type d -name prebuilds | while read -r dir; do \
      find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name "$keep" -exec rm -rf {} +; \
    done; \
    test -d "node_modules/udx-native/prebuilds/$keep" || { echo "pruned the wrong prebuild" >&2; exit 1; }

# The runtime has no shell, so anything that needs mkdir/chown happens here.
# 65532 is distroless's `nonroot` user.
RUN mkdir -p /data && chown -R 65532:65532 /data

# ---- runtime -----------------------------------------------------------
# Distroless: glibc (so the prebuilt addons load — Alpine/musl would require
# building libsodium and libudx from source), but with no shell, no package
# manager and no userland. Roughly the size of an Alpine base, with a much
# smaller attack surface. The trade-off is that `docker exec <c> sh` does not
# exist; debug with logs, /metrics, and `scripts/probe.js` from outside.
FROM gcr.io/distroless/nodejs22-debian12:nonroot

ENV NODE_ENV=production \
    MIRALL_RELAY_SEED_FILE=/data/seed \
    MIRALL_RELAY_ADMIN_HOST=0.0.0.0 \
    MIRALL_RELAY_ADMIN_PORT=9200 \
    MIRALL_RELAY_PORT=49737

WORKDIR /app
COPY --from=build --chown=65532:65532 /app /app
COPY --from=build --chown=65532:65532 /data /data

# The seed lives here. MOUNT THIS, or the relay mints a new identity on every
# container replacement and every client configured with the old key is stranded.
# A read-only secret at /run/secrets/relay_seed takes precedence and is read
# in-process (no entrypoint script needed).
VOLUME ["/data"]

# DHT traffic is UDP and must be reachable from the internet for hole-punching.
EXPOSE 49737/udp
# Admin/metrics. Binds 0.0.0.0 inside the container so a sidecar can scrape it;
# publish it ONLY to localhost or a private network — never to the internet.
EXPOSE 9200/tcp

# Exec form with an absolute path: HEALTHCHECK does not go through ENTRYPOINT,
# and there is no shell to resolve `node`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.MIRALL_RELAY_ADMIN_PORT||9200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The base image's ENTRYPOINT is /nodejs/bin/node, so CMD is just the script.
CMD ["bin/mirall-relay.js"]
