FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js vitest.config.ts ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production BIND_HOST=127.0.0.1 PORT=8787 IMPORT_ROOTS=/imports
WORKDIR /app
RUN useradd --create-home --uid 10001 appuser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY public ./public
USER appuser
EXPOSE 8787
CMD ["node", "dist/server.js"]
