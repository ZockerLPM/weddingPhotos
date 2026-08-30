# Build-Stage: volles Image mit Compiler-Toolchain,
# falls better-sqlite3 kein Prebuilt-Binary findet.
FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Runtime-Stage: schlankes Image, gleiche glibc-Basis (bookworm).
FROM node:22-bookworm-slim

# ffmpeg erzeugt die Handy-Versionen der Videos. Ohne das Paket laeuft
# alles andere unveraendert weiter, die Funktion bleibt dann nur aus.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
EXPOSE 3000
CMD ["node", "server/index.js"]
