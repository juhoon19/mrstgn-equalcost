# One image for every role. The command decides what it runs:
#   all-in-one : node src/launch.js            (default)
#   shard      : node src/server/shard-node.js
#   gateway    : node src/server/gateway-node.js
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
# Shard snapshots (mount a volume here) - see DATA_DIR.
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
VOLUME ["/data"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1
CMD ["node", "src/launch.js"]
