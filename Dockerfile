# Single image: the watcher serves the built dashboard on :8787.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY watcher/package.json watcher/
COPY dashboard/package.json dashboard/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY watcher/package.json watcher/
COPY dashboard/package.json dashboard/
RUN npm ci --omit=dev --workspace watcher --include-workspace-root=false
COPY --from=build /app/watcher/dist watcher/dist
COPY --from=build /app/dashboard/dist dashboard/dist
COPY idls idls
COPY fixtures fixtures
COPY alerts.yaml alerts.demo.yaml ./
EXPOSE 8787
CMD ["node", "watcher/dist/index.js"]
