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

That's it! The tool automatically downloads new Rust versions and re-extracts data when patches are released.
