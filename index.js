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
    console.log('');
    
    // Start the API server
    console.log('🌐 Starting Rust Items API server...');
    const apiServer = require('./api-server');
    
    // Start continuous monitoring (this will run in the background)
    steamManager.startContinuousMonitoring().catch(error => {
        console.error('❌ Error in continuous monitoring:', error.message);
    });
    
    console.log('✅ Both services are now running!');
    console.log(`📚 API available at: http://localhost:${process.env.PORT || 3100}`);
    console.log(`📖 Swagger docs at: http://localhost:${process.env.PORT || 3100}/api-docs`);
    console.log('🔄 Continuous monitoring is running in the background');
    console.log('Press Ctrl+C to stop all services.');
}

if (require.main === module) {
    main();
}

module.exports = AssetRipperManager;
