# syntax=docker/dockerfile:1
FROM node:22-alpine3.21

LABEL org.opencontainers.image.title="Neon Pixel Arcade" \
      org.opencontainers.image.description="Retro HTML5 Canvas arcade games with real-time sync engine" \
      org.opencontainers.image.version="2.1.0" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/x-4/Retro-Arcade" \
      org.opencontainers.image.vendor="Neon Pixel Arcade Contributors"

# tini: 容器 PID 1 信号转发与僵尸进程回收；libc6-compat: 兼容 ARM64 跨区同步组件动态链接器
RUN apk add --no-cache tini ca-certificates libc6-compat curl tar \
 && mkdir -p /app /app/.cache-sync \
 && chown -R node:node /app/.cache-sync

WORKDIR /app
COPY package.json index.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY LICENSE ./

ENV NODE_ENV=production \
    PORT=8080 \
    UV_THREADPOOL_SIZE=8

EXPOSE 8080

USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/index.js", "--healthcheck"]
