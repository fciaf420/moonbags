# Stage 1 — build the Vite dashboard frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# vite outDir is "../public", so the build lands in /app/public

# Stage 2 — runtime
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache bash curl

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
COPY --from=frontend-builder /app/public ./public/

EXPOSE 8787

# onchainos CLI is required at runtime for OKX discovery + WSS. Install on
# first boot (and cache to /root/.local/bin via the npm script). The relay
# role doesn't need onchainos, so it skips the install.
ENV PATH="/root/.local/bin:${PATH}"
CMD ["sh", "-c", "\
  if [ \"$APP_ROLE\" = \"private-signal-relay\" ]; then \
    exec npm run private-feed:relay; \
  fi; \
  if ! command -v onchainos >/dev/null 2>&1; then \
    npm run install:onchainos || echo 'onchainos install failed — OKX discovery disabled'; \
  fi; \
  exec npm run start \
"]
