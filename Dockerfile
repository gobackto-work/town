# town: the BFF and the built client, in one image.
#
# One image rather than two because the BFF serves the client's assets itself. That is
# the point of the single-deployment shape: there is no separate web server, no CORS,
# and no second place for the identity to live.
#
# Node rather than distroless, unlike the pestilence and scarab images: there is no
# static binary to extract, and a node runtime is the smallest thing that can run this.

# Digest-pinned. `node:24-slim` and `node:24-bookworm-slim` are the same image, so this
# digest is shared with scarab's agent image. A tag can be moved; a digest cannot.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# One RUN rather than two: a second layer buys nothing here, and hadolint is right
# that consecutive RUNs are a smell.
#
# The re-install drops the dev dependencies. `npm ci` wipes node_modules first, so
# this REPLACES the toolchain rather than adding to it -- the final image carries hono
# and nothing from eslint, vite or typescript.
RUN npm run build && npm ci --omit=dev

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production

# Only what runs. src/ is needed because node strips types at startup rather than a
# build step compiling the server.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/shared ./src/shared
COPY --from=build /app/dist ./dist

# The `node` user's uid. Numeric rather than named: with runAsNonRoot the kubelet must
# be able to verify the user is non-root, and it cannot resolve a name from the image
# config. The town namespace enforces PSA `restricted`, so this is a contract.
USER 1000

EXPOSE 8080
CMD ["node", "src/server/index.ts"]
