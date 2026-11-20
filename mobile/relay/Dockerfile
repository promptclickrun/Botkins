# The self-hosted relay (node/server.mjs). Build from the mobile folder:
#   docker build -f relay/Dockerfile .
# Only the relay's sources and the vendored QR generator for its pairing page go in
# (see Dockerfile.dockerignore beside this file).
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY relay/src ./src
COPY relay/node ./node
COPY link-host/vendor/qrcode.mjs /app/link-host/vendor/qrcode.mjs

RUN groupadd --system --gid 10002 relay \
  && useradd --system --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin relay \
  && install -d -o relay -g relay -m 0700 /var/lib/botkins-relay

ENV PORT=8080 \
    DATA_DIR=/var/lib/botkins-relay
USER relay
EXPOSE 8080
CMD ["node", "node/server.mjs"]
