const AssetRipperManager = require('./asset-ripper-manager');

async function main() {
    const manager = new AssetRipperManager();
    
    try {
        await manager.extractRustItems();
    } catch (error) {
        console.error('Extraction failed:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = AssetRipperManager;
