# API/worker image WITH the Assistant's web browser (Playwright + Chromium).
# Chromium does not run on Alpine, so this image uses Debian (bigger: ~1 GB).
# Use it instead of api.Dockerfile only if you want the Assistant to use websites (e.g. myTNB).
# Not yet tested in production — see HANDOVER.md "Verification status".

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/nodes/package.json packages/nodes/
COPY packages/engine/package.json packages/engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
# Playwright is optional, so it is not in package.json: add it here.
RUN npm install --no-save --no-audit --no-fund playwright@1 -w apps/api
COPY packages packages
COPY apps/api apps/api
RUN npm run build:packages && npm run build -w apps/api

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ASSISTANT_FILES_DIR=/app/assistant-files
WORKDIR /app
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
# Chromium and the system libraries it needs.
RUN npx playwright install --with-deps chromium && mkdir -p /app/assistant-files && chown node:node /app/assistant-files
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
