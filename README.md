# Rust Item Extractor

[![Deploy Rust API](https://github.com/nerif-tafu/rust-api/actions/workflows/deploy.yml/badge.svg)](https://github.com/nerif-tafu/rust-api/actions/workflows/deploy.yml)
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