# Rust Items API - GHCR image
# Debian base required for SteamCMD (needs bash and 32-bit libs; Alpine has no bash)
FROM node:20-bookworm-slim

WORKDIR /app

# SteamCMD dependencies: bash, 32-bit libs, curl, unzip
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    lib32gcc-s1 \
    unzip \
    && dpkg --add-architecture i386 \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends libcurl4-openssl-dev:i386 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies (omit dev for smaller image)
RUN npm ci --omit=dev

# Copy application code
COPY *.js ./

# Create directories used at runtime (game-data, steam-cmd, etc. can be mounted or populated at run)
RUN mkdir -p game-data processed-data export-data logs

EXPOSE 3100

ENV NODE_ENV=production
ENV PORT=3100

CMD ["node", "index.js"]
