# ---- build ----------------------------------------------------------------
# Compiles the shared package and the API. The build stage keeps dev
# dependencies; the runtime stage does not.
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --workspace @sas/shared --workspace @sas/backend --include-workspace-root

COPY packages/shared ./packages/shared
COPY backend ./backend

RUN npm run build --workspace @sas/shared \
 && npm run build --workspace @sas/backend

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user. The base image ships a `node` user for exactly this.
RUN chown -R node:node /app
USER node

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/backend/package.json ./backend/

RUN npm ci --omit=dev --workspace @sas/backend --include-workspace-root \
 && npm cache clean --force

COPY --from=build --chown=node:node /app/backend/dist ./backend/dist

EXPOSE 4000

# Checks readiness, not just liveness: a container whose database has gone away
# should be reported unhealthy rather than quietly failing requests.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/server.js"]
