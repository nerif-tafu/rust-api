# Rust Item Extractor

Automatically extracts item data from Rust game files and keeps it updated.

## Quick Start

1. Create a `.env` file with your Steam credentials:
   ```
   STEAM_USERNAME=your_username
   STEAM_PASSWORD=your_password
   STEAM_APP_ID=252490
   ```

2. Run `npm start` - this will download Rust, extract items, and monitor for updates every minute.

## API Server

The REST API server with Swagger documentation starts automatically with `npm start`.

### Configuration

The API server can be configured using environment variables:

- **`PORT`** - Server port (default: 3100)
- **`API_BASE_URL`** - Full base URL for the API (default: `http://localhost:3100`)

### Access

The API will be available at `http://localhost:3100` (or your custom port) with interactive documentation at `/api-docs`.

**Example `.env` configuration:**
```
STEAM_USERNAME=your_username
STEAM_PASSWORD=your_password
STEAM_APP_ID=252490
PORT=8080
API_BASE_URL=http://your-domain.com:8080
```

That's it! The tool automatically downloads new Rust versions and re-extracts data when patches are released.
