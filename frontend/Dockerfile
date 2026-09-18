# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --workspace @sas/shared --workspace @sas/frontend --include-workspace-root

COPY packages/shared ./packages/shared
COPY frontend ./frontend

# Vite inlines VITE_* values at build time, so the API origin is a build arg
# rather than a runtime environment variable.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build --workspace @sas/shared \
 && npm run build --workspace @sas/frontend

# ---- runtime --------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
