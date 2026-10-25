FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
# Factory's npm distribution pins the CLI and disables its automatic updater.
ARG DROID_VERSION=0.249.0
RUN npm install --global droid@${DROID_VERSION}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8090 SCHEDULE_DATA_DIR=/data DROID_EXEC_PATH=/usr/local/bin/droid
EXPOSE 8090
CMD ["node", "dist/server.js"]
