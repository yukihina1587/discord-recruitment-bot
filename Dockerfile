FROM node:24.12.0-alpine3.23@sha256:c720a25dd3a78e6274d55267e76d89e5c096c46940b5ea83f7a99978feb0b514

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

RUN mkdir -p /app/data \
    && chown node:node /app/data

COPY --chown=node:node index.js config.js deploy-commands.js healthcheck.js ./
COPY --chown=node:node commands ./commands
COPY --chown=node:node lib ./lib
COPY --chown=node:node runtime ./runtime

USER node
CMD ["node", "index.js"]
