# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/nodes/package.json packages/nodes/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/api apps/api
RUN npm run build:packages && npm run build -w apps/api \
  && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Only compiled output and production dependencies.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/nodes/package.json packages/nodes/
COPY --from=build /app/packages/nodes/dist packages/nodes/dist
COPY --from=build /app/packages/engine/package.json packages/engine/
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "apps/api/dist/server.js"]
