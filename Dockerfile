# syntax=docker/dockerfile:1

# Build stage: install deps (dev deps include esbuild/tsc) and bundle the Node
# entry into a single file, so the runtime image needs no node_modules.
FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.23.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.node.json worker-configuration.d.ts ./
COPY src ./src
RUN pnpm run build:node

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    KV_FILE=/data/kv.json
WORKDIR /app
COPY --from=build /app/dist/server.mjs ./server.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.mjs"]
