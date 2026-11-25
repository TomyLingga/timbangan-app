# Web image: Next.js on Node 24, served with `next start`.
# Build context: apps/web. Built and started by deploy/docker-compose.yml.
# NEXT_PUBLIC_API_URL, NEXT_PUBLIC_MAP_TILES_URL and NEXT_PUBLIC_SCANNER_URL are inlined into the browser code at
# build time, so a change of any of them needs a new build of this image.

# --- build: all dependencies, next build ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_MAP_TILES_URL=
# empty: the address the scanner helper of the old application listens on (src/lib/config.ts)
ARG NEXT_PUBLIC_SCANNER_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_MAP_TILES_URL=$NEXT_PUBLIC_MAP_TILES_URL \
    NEXT_PUBLIC_SCANNER_URL=$NEXT_PUBLIC_SCANNER_URL
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "The build argument NEXT_PUBLIC_API_URL is required." >&2; exit 1; }
# public/ is empty in git and so may be missing in a fresh checkout
RUN mkdir -p public && npm run build && rm -rf .next/cache

# --- runtime: production dependencies only ---
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Jakarta \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
