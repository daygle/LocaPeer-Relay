#!/bin/sh
# Prefer the tunnel token written by the relay's admin panel (tunnel.env in
# the shared data volume); fall back to the container environment
# (TUNNEL_TOKEN from .env) for first boot before a token is saved.
set -a
if [ -f /data/tunnel.env ]; then
  . /data/tunnel.env
fi
set +a
exec /usr/local/bin/cloudflared --no-autoupdate "$@"
