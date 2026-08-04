#!/bin/sh
# Prefer a Docker/Compose secret over an environment variable: env vars leak into
# `docker inspect`, process listings and crash reports; a secret file does not.
set -e

if [ -z "$MIRALL_RELAY_SEED" ] && [ -f /run/secrets/relay_seed ]; then
  MIRALL_RELAY_SEED="$(cat /run/secrets/relay_seed)"
  export MIRALL_RELAY_SEED
fi

exec "$@"
