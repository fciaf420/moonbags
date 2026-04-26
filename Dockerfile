# Stage 1 — build the Vite dashboard frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# Output lands in /app/public (vite outDir: "../public")

# Stage 2 — runtime
FROM node:20-alpine
WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Copy source and built frontend
COPY src/ ./src/
COPY tsconfig.json ./
COPY --from=frontend-builder /app/public ./public/

EXPOSE 8787

CMD ["node", "--dns-result-order=ipv4first", "--import", "tsx", "src/main.ts"]
