# API image: Fastify on Node 24 (glibc, because the native modules ship linux-x64-gnu binaries).
# Build context: apps/api. Built and started by deploy/docker-compose.yml.

# --- build: all dependencies, TypeScript to dist/ ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime: production dependencies only ---
FROM node:24-bookworm-slim
# Paths match the volumes in deploy/docker-compose.yml.
# LD_LIBRARY_PATH: sherpa-onnx-node loads its addon and the onnxruntime library from that package folder.
ENV NODE_ENV=production \
    TZ=Asia/Jakarta \
    HOST=0.0.0.0 \
    PORT=3100 \
    FILE_STORAGE_DIR=/data/files \
    TTS_CACHE_DIR=/data/tts-cache \
    TTS_MODEL_DIR=/models/tts \
    LD_LIBRARY_PATH=/app/node_modules/sherpa-onnx-linux-x64
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# src/db/migrate.ts reads ../../migrations relative to dist/db, i.e. /app/migrations
COPY migrations ./migrations
# Mount points; a new named volume takes over the owner of these folders, so the node user can write to them.
RUN mkdir -p /data/files /data/tts-cache /models/tts /plan && chown -R node:node /data
USER node
EXPOSE 3100
# Applies the migrations that are not in the database yet, then starts the server.
CMD ["sh", "-c", "node dist/cli/migrate.js && exec node dist/server.js"]
