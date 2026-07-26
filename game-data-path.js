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

module.exports = { GAME_DATA_DIR, gameDataPath };
