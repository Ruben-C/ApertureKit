# Build from a checkout of the repo:  docker compose up -d --build
# (or: docker build -t aperturekit . && docker run ... — see README)
#
# Needs Node 24.7+ (built-in node:sqlite and crypto.argon2); 24 is the LTS line.
FROM node:24-alpine

WORKDIR /app

# Install only production dependencies, cached separately from the source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Everything persistent (SQLite database, uploads, session secret) lives in
# /data. Pre-create it owned by the unprivileged `node` user (uid 1000) so a
# fresh named volume inherits that ownership.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PORTAL_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# node:sqlite is stable in practice but still prints an ExperimentalWarning
# at startup; keep it out of the container log.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
