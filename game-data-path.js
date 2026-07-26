const path = require('path');

/**
 * Directory for the downloaded Rust client and the item data/images
 * extracted from it. Set GAME_DATA_DIR to point this at a mounted
 * persistent volume in production, so the multi-gigabyte download survives
 * pod restarts instead of being re-fetched into ephemeral container storage
 * on every start. Defaults to a directory next to this file for local
 * development.
 */
const GAME_DATA_DIR = process.env.GAME_DATA_DIR
    ? path.resolve(process.env.GAME_DATA_DIR)
    : path.resolve(__dirname, 'game-data');

function gameDataPath(...segments) {
    return path.join(GAME_DATA_DIR, ...segments);
}

/**
 * The extracted item data is what the API actually serves, so it needs the
 * same treatment as the download: left in the container's own filesystem it
 * is wiped on every image update and the API serves nothing until a full
 * re-extraction has run. Set DATA_DIR alongside GAME_DATA_DIR in production.
 */
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(__dirname);

const PROCESSED_DATA_DIR = path.join(DATA_DIR, 'processed-data');

/**
 * AssetRipper's own binaries and its raw export are deliberately *not* on the
 * volume. They are regenerable intermediates only needed while an extraction
 * is running, and the volume is sized for the game download with little room
 * to spare — putting a second copy of the bundle contents next to it risks
 * filling it.
 */
const EXPORT_DATA_DIR = path.resolve(__dirname, 'export-data');
const ASSET_RIPPER_DIR = path.resolve(__dirname, 'asset-ripper');

module.exports = {
    GAME_DATA_DIR,
    gameDataPath,
    DATA_DIR,
    PROCESSED_DATA_DIR,
    EXPORT_DATA_DIR,
    ASSET_RIPPER_DIR
};
