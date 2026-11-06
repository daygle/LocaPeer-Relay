# Build stage: TypeScript needs the dev dependencies, and a native addon such
# as better-sqlite3 falls back to node-gyp on any platform without a bundled
# prebuild. That toolchain lives only here and never reaches the runtime image.
FROM node:26-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop build-only packages (TypeScript, tsx, type definitions); the native
# addon installed above stays in node_modules.
RUN npm prune --omit=dev

# Runtime stage: no python3/make/g++, no dev dependencies.
FROM node:26-alpine

WORKDIR /app

# package.json is read at runtime for the relay version (NIP-11 and the panel).
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY admin ./admin

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=7777
ENV DB_PATH=/data/relay.db

EXPOSE 7777

VOLUME ["/data"]

CMD ["node", "dist/index.js"]
