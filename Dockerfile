# syntax=docker/dockerfile:1
FROM node:22-alpine

# tini: 容器 PID 1 信号转发与僵尸进程回收；ca-certificates/curl/tar: 基础网络与归档工具
RUN apk add --no-cache tini ca-certificates curl tar \
 && mkdir -p /app /app/.cache-sync \
 && chown -R node:node /app

WORKDIR /app
COPY --chown=node:node package.json index.js ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

USER node
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/index.js", "--healthcheck"]
