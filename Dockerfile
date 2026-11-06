FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26-alpine AS runtime
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000 LAD_AUTH_ENABLED=1 LAD_BACKUP_DIR=/backups
WORKDIR /app
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /backups && chown node:node /backups
USER node
EXPOSE 3000
CMD ["node", "scripts/serve.mjs"]
