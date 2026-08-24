# SPDX-License-Identifier: Apache-2.0
#
# Container image for @askturret/mcp-gateway (#57, §4 container catalogue).
#
# Built from the WORKSPACE ROOT, not from this directory:
#
#   docker build -f packages/gateway/Dockerfile -t askturret/mcp-gateway .
#
# The gateway depends on four sibling workspace packages, and none of them are
# published yet (see the release-policy issue referenced in the README). So the
# image has to compile them from source rather than install them — a Dockerfile
# that ran `npm i @askturret/mcp-gateway` would not build today, and would go on
# not building silently once the registry did have a stale version.

# --- build -------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Manifests first, so a dependency install is cached independently of source
# edits. Without this every source change re-runs `npm ci` from scratch.
COPY package.json package-lock.json ./
COPY packages/core/package.json                packages/core/
COPY packages/transports/package.json          packages/transports/
COPY packages/sources-openapi/package.json     packages/sources-openapi/
COPY packages/observability/package.json       packages/observability/
COPY packages/gateway/package.json             packages/gateway/
COPY packages/adapters-express/package.json    packages/adapters-express/
COPY packages/adapters-fastify/package.json    packages/adapters-fastify/
COPY packages/explorer/package.json            packages/explorer/
COPY packages/cli/package.json                 packages/cli/
COPY packages/reliability/package.json         packages/reliability/
COPY packages/adapter-conformance/package.json packages/adapter-conformance/
COPY packages/adapter-test/package.json        packages/adapter-test/
COPY packages/examples/package.json            packages/examples/

RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/

RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:20-alpine AS runtime

# `dumb-init` reaps zombies and forwards signals, so the SIGTERM a container
# runtime sends actually reaches the gateway's shutdown handler. Without an init
# the process runs as PID 1, where the default SIGTERM disposition is to ignore
# it — the container would sit until the runtime's kill timeout and the audit
# sink would never flush.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json

# Non-root. The gateway needs no write access outside a mounted audit volume,
# and `node:alpine` ships this user for exactly this.
USER node

# 7000 = MCP, 9464 = Prometheus scrape. Two ports because an operator should be
# able to publish the first and keep the second on an internal network.
EXPOSE 7000 9464

ENTRYPOINT ["dumb-init", "--", "node", "packages/gateway/dist/cli.js"]

# No CMD with a --spec: there is no sensible default spec, and one baked in
# would produce a container that starts and serves the wrong API. Supply flags
# at `docker run`, or mount a config file and pass --config.
