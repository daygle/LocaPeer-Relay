# Wrapper around the official cloudflared image so the tunnel token can be
# managed from the relay's admin panel. The stock image is distroless (no
# shell), so we base on Alpine and add an entrypoint that sources
# /data/tunnel.env - the file the relay writes when the token is saved in
# the admin panel - before launching cloudflared.
FROM alpine:3.20

COPY --from=cloudflare/cloudflared:latest /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

# Same nonroot uid the stock image runs as, so it can read tunnel.env when
# the relay chowns the file to 65532.
USER 65532:65532

ENTRYPOINT ["/entrypoint.sh"]
