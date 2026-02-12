# Rust Item Extractor

[![Publish to GHCR](https://github.com/nerif-tafu/rust-api/actions/workflows/publish.yml/badge.svg)](https://github.com/nerif-tafu/rust-api/actions/workflows/publish.yml)

Automatically extracts item data from Rust game files and keeps it updated.

## Quick Start

1. Create a `.env` file with your Steam credentials:
   ```
   STEAM_USERNAME=your_username
   STEAM_PASSWORD=your_password
   STEAM_APP_ID=252490
   PORT=8080
   API_BASE_URL=http://your-domain.com:8080
   ```

2. Run `npm start` - this will download Rust, extract items, and monitor for updates every minute.

The API will be available at `http://localhost:3100` (or your custom port) with interactive documentation at `/api-docs`.

## Testing the Docker image locally

Before pushing a version tag (which publishes to GHCR), you can build and run the image locally:

```bash
# Build the image (same Dockerfile used in CI)
npm run docker:build

# Run the container (uses your .env; port 3100)
npm run docker:run
```

Or in one step:

```bash
npm run docker:test
```

Then open `http://localhost:3100`. To test a specific version tag locally without pushing:

```bash
docker build -t rust-api:v1.0.0 .
docker run --rm -p 3100:3100 --env-file .env rust-api:v1.0.0
```