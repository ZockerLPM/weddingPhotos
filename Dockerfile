# Build-Stage: volles Image mit Compiler-Toolchain,
# falls better-sqlite3 kein Prebuilt-Binary findet.
FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Runtime-Stage: schlankes Image, gleiche glibc-Basis (bookworm).
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
EXPOSE 3000
CMD ["node", "server/index.js"]
