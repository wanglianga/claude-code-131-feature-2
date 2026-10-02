# 悦安月子中心平台 —— 一键启动镜像
# node:sqlite 需 Node >= 22.5（官方 node:22 镜像内置 SQLite）
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV MCARE_DB=/app/data/mcare.db
# 容器内以 node 用户运行，数据目录需可写
RUN mkdir -p /app/data && chown -R node:node /app/data
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["npm", "start"]
