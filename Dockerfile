# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------- #
# Build stage
# ---------------------------------------------------------------------------- #
FROM node:22-slim AS builder

WORKDIR /build

# Install dependencies (including devDependencies for the build).
# --ignore-scripts: the `prepare` script runs the build, but src/ isn't copied
# yet — we build explicitly below once sources are present.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile; the build script also copies schema.sql into dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------- #
# Runtime stage
# ---------------------------------------------------------------------------- #
FROM node:22-slim AS runtime

WORKDIR /app

# Copy compiled output and manifests
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/package-lock.json ./package-lock.json

# Install production dependencies only. --ignore-scripts: dist is already built
# and copied; the `prepare` build must not run here (no devDeps, no src).
RUN npm ci --omit=dev --ignore-scripts

# Run as non-root
RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser
USER appuser

# API server by default.
# To run the worker instead, override the command:
#   docker run <image> node dist/entrypoints/worker.js
EXPOSE 8080
CMD ["node", "dist/entrypoints/server.js"]
