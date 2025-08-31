# AssetRipper Rust Extractor

A Node.js tool for extracting item information from Rust game files using AssetRipper.

## Project Structure

```
/
├── asset-ripper/          # Downloaded AssetRipper executable and files
│   └── logs/             # AssetRipper log files
├── steam-cmd/             # SteamCMD executable and files
├── export-data/           # Exported Unity project data from AssetRipper
├── processed-data/        # Final JSON output files
├── game-data/             # Rust bundle files (items.preload.bundle)
├── asset-ripper-manager.js # AssetRipper management library
├── steamcmd-manager.js    # SteamCMD management library
├── index.js              # Main extraction script
├── package.json          # Node.js dependencies
├── .env                  # Steam credentials (not in version control)
└── README.md             # This file
```

## Prerequisites

- Node.js (v14 or higher)
- Internet connection (for downloading AssetRipper and SteamCMD)
- On macOS/Linux: `unzip` and `tar` commands (usually pre-installed)
- On Windows: PowerShell (pre-installed)
- Steam account with Rust purchased

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create .env file with Steam credentials:**
   ```bash
   echo "STEAM_USERNAME=your_username" > .env
   echo "STEAM_PASSWORD=your_password" >> .env
   echo "STEAM_APP_ID=252490" >> .env
   ```

3. **Download Rust game files (optional):**
   ```bash
   npm run download-rust
   ```
   
   This will:
   - Download and setup SteamCMD
   - Download Rust game files to `game-data/`
   - Automatically locate and copy the bundle file

4. **Extract item data:**
   ```bash
   npm start
   ```
   
   The script will automatically:
   - Create the required directory structure
   - Download and configure AssetRipper if needed
   - Extract item data from your Rust bundle file

## Usage

### Option 1: Download Rust files automatically
1. **Download Rust game files:**
   ```bash
   npm run download-rust
   ```

2. **Extract item data:**
   ```bash
   npm start
   ```

### Option 2: Use existing Rust files
1. **Place your Rust bundle file** (e.g., `items.preload.bundle`) in the `game-data` directory.

2. **Run the extraction:**
   ```bash
   npm start
   ```
   
   This will:
   - Automatically set up AssetRipper if needed
   - Create required directories
   - Start AssetRipper
   - Load your bundle file
   - Extract all item definitions and blueprints
   - Save the results to `processed-data/rust_items.json`
   - Create a summary in `processed-data/extraction_summary.json`

## Output Files

- `processed-data/rust_items.json` - Complete item data with crafting recipes
- `processed-data/extraction_summary.json` - Summary statistics

## Supported Operating Systems

- **macOS** (ARM64): Downloads `AssetRipper_mac_arm64.zip`
- **Linux** (x64): Downloads `AssetRipper_linux_x64.zip`
- **Windows** (x64): Downloads `AssetRipper_win_x64.zip`

## Troubleshooting

### AssetRipper not found
If you get an error about AssetRipper not being found, run:
```bash
npm run setup
```

### Bundle file not found
If you get an error about the bundle file not being found, make sure your `items.preload.bundle` file is in the `game-data` directory.

### Steam credentials not found
If you get an error about Steam credentials, make sure your `.env` file contains:
```
STEAM_USERNAME=your_username
STEAM_PASSWORD=your_password
STEAM_APP_ID=252490
```

### SteamCMD download issues
If SteamCMD fails to download, check your internet connection and try again. The script will automatically retry on redirects.

### Permission denied on macOS/Linux
If you get permission errors, make sure the AssetRipper executable has the right permissions:
```bash
chmod +x asset-ripper/AssetRipper.GUI.Free
```

### Port already in use
If port 54691 is already in use, you can modify the port in `index.js` by changing the constructor parameter:
```javascript
const extractor = new RustItemExtractor(54692); // Use different port
```

## Manual Setup (Alternative)

If the automatic setup doesn't work, you can manually:

1. Download AssetRipper from: https://github.com/AssetRipper/AssetRipper/releases
2. Extract it to the `asset-ripper/` directory
3. Ensure the executable is named correctly:
   - macOS/Linux: `AssetRipper.GUI.Free`
   - Windows: `AssetRipper.GUI.Free.exe`

## License

MIT
