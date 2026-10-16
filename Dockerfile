# Cue Club: the game (static build) and its server (rooms + referee) in one small Node image.
# Served under /cue-club/ by the games gateway (prefix stripped): everything here is at /.
# The server runs TypeScript directly (Node ≥ 24 strips the types), importing the same
# simulation the browsers use: src/sim and src/net ship in the image alongside dist/.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY tests ./tests
RUN npm run build && npx vitest run

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY src/sim ./src/sim
COPY src/net/protocol.ts src/net/tournament.ts ./src/net/
COPY src/play/stroke.ts ./src/play/
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/index.ts"]
