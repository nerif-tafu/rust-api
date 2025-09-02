require('dotenv').config();
const AssetRipperManager = require('./asset-ripper-manager');
const SteamCMDManager = require('./steamcmd-manager');

async function main() {
    // Ensure Rust game files are available (includes credential validation)
    const steamManager = new SteamCMDManager();
    await steamManager.ensureRustFilesAvailable();
    
    // Start continuous monitoring for Rust updates
    console.log('🚀 Starting continuous monitoring for Rust updates...');
    console.log('This will check for updates every minute and automatically extract new data when available.');
    console.log('Press Ctrl+C to stop monitoring.');
    console.log('');
    
    await steamManager.startContinuousMonitoring();
}

if (require.main === module) {
    main();
}

module.exports = AssetRipperManager;
