require('dotenv').config();
const AssetRipperManager = require('./asset-ripper-manager');
const SteamCMDManager = require('./steamcmd-manager');

// Global status tracking for API server communication
global.serverStatus = {
    updateStatus: null
};

async function main() {
    console.log('🚀 Starting Rust API server...');
    
    // Start the API server first (it will initialize with status 1)
    console.log('🌐 Starting Rust Items API server...');
    const apiServer = require('./api-server');
    
    // Wait a moment for API server to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Update status to indicate Steam setup is starting
    if (global.serverStatus.updateStatus) {
        global.serverStatus.updateStatus(2, 'Steam setup starting - validating credentials and checking game files');
    }
    
    // Ensure Rust game files are available (includes credential validation)
    const steamManager = new SteamCMDManager();
    await steamManager.ensureRustFilesAvailable();
    
    // Update status to indicate AssetRipper setup
    if (global.serverStatus.updateStatus) {
        global.serverStatus.updateStatus(4, 'AssetRipper setup - preparing for item extraction');
    }
    
    // Start continuous monitoring for Rust updates
    console.log('🚀 Starting continuous monitoring for Rust updates...');
    console.log('This will check for updates every minute and automatically extract new data when available.');
    console.log('');
    
    // Start continuous monitoring (this will run in the background)
    steamManager.startContinuousMonitoring().catch(error => {
        console.error('❌ Error in continuous monitoring:', error.message);
    });
    
    // Update status to indicate server is ready
    if (global.serverStatus.updateStatus) {
        global.serverStatus.updateStatus(5, 'Server ready - all services running and API available');
    }
    
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
