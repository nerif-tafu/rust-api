const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3100;

// Trust proxy headers (for rate limiting and IP detection behind reverse proxies)
// Set to 1 to trust the first proxy in the chain (e.g., Cloudflare, nginx)
app.set('trust proxy', 1);

// Server readiness status
let serverStatus = {
    status: 0, // 0: Not started, 1: Basic setup, 2: Steam setup, 3: Game downloading, 4: AssetRipper setup, 5: Ready
    message: 'Server starting up...',
    details: {},
    startTime: new Date(),
    lastUpdate: new Date(),
    lastUpdateCheck: new Date()
};

// In-memory log storage
let serverLogs = [];
const MAX_LOG_LINES = 1000;

// Function to add log entry
function addLogEntry(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp: timestamp,
        level: level,
        message: message
    };
    
    serverLogs.push(logEntry);
    
    // Keep only the last MAX_LOG_LINES entries
    if (serverLogs.length > MAX_LOG_LINES) {
        serverLogs = serverLogs.slice(-MAX_LOG_LINES);
    }
    
    // Also log to console using the original console.log to avoid recursion
    originalConsoleLog(message);
}

// Override console.log to capture logs
const originalConsoleLog = console.log;
console.log = function(...args) {
    const message = args.join(' ');
    addLogEntry(message, 'info');
    originalConsoleLog.apply(console, args);
};

// Override console.error to capture errors
const originalConsoleError = console.error;
console.error = function(...args) {
    const message = args.join(' ');
    addLogEntry(message, 'error');
    originalConsoleError.apply(console, args);
};

// Override console.warn to capture warnings
const originalConsoleWarn = console.warn;
console.warn = function(...args) {
    const message = args.join(' ');
    addLogEntry(message, 'warn');
    originalConsoleWarn.apply(console, args);
};

function updateStatus(status, message, details = {}) {
    serverStatus.status = status;
    serverStatus.message = message;
    serverStatus.details = details;
    serverStatus.lastUpdate = new Date();
    
    // Update last update check time if this is related to update checking
    if (message.includes('checking') || message.includes('update') || message.includes('monitoring')) {
        serverStatus.lastUpdateCheck = new Date();
    }
    
    // Log progress updates specifically
    if (details.progress !== undefined) {
        console.log(`🔄 Status ${status}: ${message} - Progress: ${details.progress}%`);
    } else {
        console.log(`🔄 Status ${status}: ${message}`);
    }
}

// Make updateStatus available globally for index.js
global.serverStatus = global.serverStatus || {};
global.serverStatus.updateStatus = updateStatus;

// Add initial log entries
addLogEntry('🚀 Starting Rust API server...');
addLogEntry('🌐 Starting Rust Items API server...');

// Initialize with basic setup
updateStatus(1, 'Basic setup complete - Express server initialized');

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting configuration
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000, // Limit each IP to 10,000 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many requests from this IP, please try again later.',
            retryAfter: '15 minutes',
            limit: req.rateLimit.limit,
            remaining: req.rateLimit.remaining,
            resetTime: new Date(req.rateLimit.resetTime).toISOString()
        });
    }
});

const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 3000, // Limit each IP to 3,000 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many requests from this IP, please try again later.',
            retryAfter: '15 minutes',
            limit: req.rateLimit.limit,
            remaining: req.rateLimit.remaining,
            resetTime: new Date(req.rateLimit.resetTime).toISOString()
        });
    }
});



// Apply general rate limiting to all routes
app.use(generalLimiter);

// Security headers middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Debug endpoint to check current server status details
app.get('/debug/status', (req, res) => {
    // Read log files for debugging
    let appLogs = [];
    let errorLogs = [];
    
    try {
        const appLogPath = path.join(__dirname, 'logs', 'app.log');
        if (fs.existsSync(appLogPath)) {
            const appLogContent = fs.readFileSync(appLogPath, 'utf8');
            appLogs = appLogContent.split('\n').slice(-50).filter(line => line.trim() !== '');
        }
    } catch (error) {
        appLogs = [`Error reading app.log: ${error.message}`];
    }
    
    try {
        const errorLogPath = path.join(__dirname, 'logs', 'error.log');
        if (fs.existsSync(errorLogPath)) {
            const errorLogContent = fs.readFileSync(errorLogPath, 'utf8');
            errorLogs = errorLogContent.split('\n').slice(-50).filter(line => line.trim() !== '');
        }
    } catch (error) {
        errorLogs = [`Error reading error.log: ${error.message}`];
    }
    
    res.json({
        currentStatus: serverStatus,
        globalServerStatus: global.serverStatus ? 'Available' : 'Not available',
        timestamp: new Date().toISOString(),
        logs: {
            app: appLogs,
            error: errorLogs
        }
    });
});

// Health check endpoint for deployment verification
app.get('/health', (req, res) => {
    const uptime = Date.now() - serverStatus.startTime.getTime();
    res.json({
        status: serverStatus.status,
        message: serverStatus.message,
        details: serverStatus.details,
        uptime: Math.floor(uptime / 1000), // seconds
        startTime: serverStatus.startTime.toISOString(),
        lastUpdate: serverStatus.lastUpdate.toISOString(),
        ready: serverStatus.status >= 5
    });
});

// Readiness check endpoint (for deployment workflow)
app.get('/ready', (req, res) => {
    if (serverStatus.status >= 5) {
        res.status(200).json({
            ready: true,
            status: serverStatus.status,
            message: serverStatus.message,
            details: serverStatus.details
        });
    } else {
        res.status(503).json({
            ready: false,
            status: serverStatus.status,
            message: serverStatus.message,
            details: serverStatus.details
        });
    }
});

// Swagger configuration
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Rust Items API',
            version: '1.2.0',
            description: 'API for Rust game items, crafting recipes, and item images',
            contact: {
                name: 'Rust Items Extractor',
                url: 'https://github.com/nerif-tafu/rust-api'
            }
        },
        servers: [
            {
                url: 'https://rust-api.tafu.casa',
                description: 'Production server'
            },
            {
                url: `http://localhost:${PORT}`,
                description: 'Local development server'
            }
        ],
        components: {
            schemas: {
                Item: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', example: 'ItemDefinition' },
                        pathId: { type: 'string', example: '114761749039158340' },
                        shortname: { type: 'string', example: 'ammo.grenadelauncher.buckshot' },
                        displayName: { type: 'string', example: '40mm Shotgun Round' },
                        itemid: { type: 'number', example: 1055319033 },
                        category: { type: 'number', example: 8 },
                        categoryName: { type: 'string', example: 'Ammunition' },
                        stackable: { type: 'number', example: 24 },
                        volume: { type: 'number', example: 0 },
                        ingredients: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    amount: { type: 'number', example: 4 },
                                    itemDef: {
                                        type: 'object',
                                        properties: {
                                            m_PathID: { type: 'string', example: '114643556312930600' },
                                            shortname: { type: 'string', example: 'metal.fragments' },
                                            displayName: { type: 'string', example: 'Metal Fragments' }
                                        }
                                    }
                                }
                            }
                        },
                        craftTime: { type: 'number', example: 0 },
                        amountToCreate: { type: 'number', example: 2 },
                        workbenchLevelRequired: { type: 'number', example: 3 },
                        sourceFile: { type: 'string', example: '40mm_buckshot.item.prefab' }
                    }
                }
            }
        }
    },
    apis: ['./api-server.js']
};

const specs = swaggerJsdoc(swaggerOptions);

// Load processed items data
let itemsData = [];

function loadItemsData() {
    try {
        const itemsPath = path.join(__dirname, 'processed-data', 'rust_items.json');
        
        if (fs.existsSync(itemsPath)) {
            itemsData = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
            addLogEntry(`✅ Loaded ${itemsData.length} items from rust_items.json`);
            addLogEntry('👀 Watching for changes to rust_items.json...');
        } else {
            addLogEntry('⚠️  rust_items.json not found, items data will be empty');
        }
    } catch (error) {
        addLogEntry(`❌ Error loading items data: ${error.message}`, 'error');
        itemsData = [];
    }
}

// Initial load
loadItemsData();

// Watch for changes to rust_items.json and reload automatically
const itemsDataPath = path.join(__dirname, 'processed-data', 'rust_items.json');
let fileWatcher = null;

function setupFileWatcher() {
    if (fs.existsSync(itemsDataPath)) {
        console.log('👀 Watching for changes to rust_items.json...');
        
        try {
            // Use fs.watch for file monitoring with error handling
            fileWatcher = fs.watch(itemsDataPath, (eventType, filename) => {
                if (eventType === 'change' && filename === 'rust_items.json') {
                    console.log('🔄 rust_items.json changed, reloading data...');
                    // Small delay to ensure file write is complete
                    setTimeout(() => {
                        loadItemsData();
                        console.log('✅ Items data reloaded successfully');
                    }, 1000);
                }
            });
            
            // Handle watcher errors gracefully
            fileWatcher.on('error', (error) => {
                console.log('⚠️  File watcher error (this is normal during updates):', error.message);
                // Don't crash the server, just log the error
            });
            
        } catch (error) {
            console.log('⚠️  Could not set up file watcher (this is normal during updates):', error.message);
        }
    }
}

// Set up the file watcher initially
setupFileWatcher();

// Fallback: also check for changes every 30 seconds as backup
setInterval(() => {
    try {
        const stats = fs.statSync(itemsDataPath);
        const currentMtime = stats.mtime.getTime();
        
        if (!itemsData.lastModified || currentMtime > itemsData.lastModified) {
            console.log('🔄 rust_items.json modified, reloading data...');
            loadItemsData();
            itemsData.lastModified = currentMtime;
            console.log('✅ Items data reloaded successfully');
        }
    } catch (error) {
        // File might not exist yet, ignore errors
    }
}, 30000);

// Function to re-setup file watcher (useful after force updates)
function reSetupFileWatcher() {
    if (fileWatcher) {
        try {
            fileWatcher.close();
        } catch (error) {
            // Ignore errors when closing
        }
        fileWatcher = null;
    }
    setupFileWatcher();
}

// Export the function for use by other modules
global.reSetupFileWatcher = reSetupFileWatcher;

// Helper function to check if item image exists
function getItemImageUrl(shortname) {
    const imagePath = path.join(__dirname, 'game-data', 'Bundles', 'items', `${shortname}.png`);
    if (fs.existsSync(imagePath)) {
        return `/game-data/Bundles/items/${shortname}.png`;
    }
    return null;
}

// ZIP caching system
let cachedZipPath = null;
let cachedZipStats = null;
let cachedZipPromise = null;

function getImagesDirectoryStats() {
    const imagesDir = path.join(__dirname, 'game-data', 'Bundles', 'items');
    if (!fs.existsSync(imagesDir)) return null;
    
    try {
        const files = fs.readdirSync(imagesDir)
            .filter(file => file.endsWith('.png'))
            .map(file => path.join(imagesDir, file));
        
        if (files.length === 0) return null;
        
        // Get the most recent modification time of all PNG files
        const stats = files.map(file => fs.statSync(file));
        const latestModTime = Math.max(...stats.map(stat => stat.mtime.getTime()));
        const totalSize = stats.reduce((sum, stat) => sum + stat.size, 0);
        
        return {
            count: files.length,
            latestModTime,
            totalSize,
            files: files
        };
    } catch (error) {
        console.error('Error getting images directory stats:', error);
        return null;
    }
}

function shouldRebuildZip() {
    if (!cachedZipPath || !cachedZipStats) return true;
    
    const currentStats = getImagesDirectoryStats();
    if (!currentStats) return true;
    
    // Check if file count, total size, or latest modification time changed
    return currentStats.count !== cachedZipStats.count ||
           currentStats.totalSize !== cachedZipStats.totalSize ||
           currentStats.latestModTime !== cachedZipStats.latestModTime;
}

async function buildZipArchive() {
    const imagesDir = path.join(__dirname, 'game-data', 'Bundles', 'items');
    
    if (!fs.existsSync(imagesDir)) {
        throw new Error('Images directory not found');
    }

    const imageFiles = fs.readdirSync(imagesDir)
        .filter(file => file.endsWith('.png'))
        .map(file => path.join(imagesDir, file));

    if (imageFiles.length === 0) {
        throw new Error('No image files found');
    }

    console.log(`📦 Building ZIP archive with ${imageFiles.length} images...`);

    // Create cache directory if it doesn't exist
    const cacheDir = path.join(__dirname, 'processed-data', 'cache');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Generate unique filename based on content hash
    const stats = getImagesDirectoryStats();
    const zipFilename = `rust-items-images-${stats.count}-${stats.totalSize}-${stats.latestModTime}.zip`;
    const zipPath = path.join(cacheDir, zipFilename);

    return new Promise((resolve, reject) => {
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });

        const output = fs.createWriteStream(zipPath);

        archive.on('error', (err) => {
            console.error('❌ Error creating ZIP archive:', err);
            reject(err);
        });

        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('⚠️ Warning:', err.message);
            } else {
                console.error('❌ Archive warning:', err);
            }
        });

        archive.on('end', () => {
            console.log(`✅ ZIP archive completed successfully: ${zipPath}`);
            resolve(zipPath);
        });

        archive.pipe(output);

        // Add each image file to the archive
        imageFiles.forEach(imageFile => {
            const fileName = path.basename(imageFile);
            archive.file(imageFile, { name: fileName });
        });

        archive.finalize();
    });
}

// Routes

/**
 * @swagger
 * /:
 *   get:
 *     summary: API root
 *     description: Welcome message and API information
 *     responses:
 *       200:
 *         description: API information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 version:
 *                   type: string
 *                 endpoints:
 *                   type: array
 *                   items:
 *                     type: string
 */
app.get('/', (req, res) => {
    // Get game version information
    let gameVersion = null;
    try {
        const gameDataPath = path.join(process.cwd(), 'game-data');
        const versionFilePath = path.join(gameDataPath, 'version.txt');
        
        if (fs.existsSync(versionFilePath)) {
            gameVersion = fs.readFileSync(versionFilePath, 'utf8').trim();
        }
    } catch (error) {
        console.warn('Could not read game version:', error.message);
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rust Items API</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; margin-bottom: 40px; color: white; }
        .header h1 { font-size: 3rem; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
        .header p { font-size: 1.2rem; opacity: 0.9; }
        .status-card { background: white; border-radius: 15px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .status-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px; }
        .status-badge { padding: 8px 16px; border-radius: 25px; font-weight: bold; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; }
        .status-ready { background: #4CAF50; color: white; }
        .status-starting { background: #FF9800; color: white; }
        .version-info { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
        .version-item { background: #f8f9fa; padding: 15px; border-radius: 10px; border-left: 4px solid #667eea; flex: 1; min-width: 200px; }
        .version-item h3 { color: #667eea; margin-bottom: 5px; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; }
        .version-item p { font-size: 1.1rem; font-weight: 600; }
        .game-version { background: #e8f5e8; border-left-color: #4CAF50; }
        .game-version h3 { color: #4CAF50; }
        .endpoints-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; margin-top: 20px; }
        .endpoint-item { background: #f8f9fa; padding: 15px; border-radius: 10px; border-left: 4px solid #667eea; transition: transform 0.2s ease; }
        .endpoint-item:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .endpoint-method { display: inline-block; background: #667eea; color: white; padding: 4px 8px; border-radius: 5px; font-size: 0.8rem; font-weight: bold; margin-right: 10px; }
        .endpoint-path { font-family: 'Courier New', monospace; font-weight: bold; color: #333; }
        .endpoint-description { margin-top: 8px; color: #666; font-size: 0.9rem; }
        .rate-limits { background: #fff3cd; border-left-color: #ffc107; margin-top: 20px; }
        .rate-limits h3 { color: #856404; }
        .rate-limit-item { margin: 10px 0; padding: 10px; background: white; border-radius: 8px; border-left: 3px solid #ffc107; }
        .action-buttons { display: flex; gap: 15px; margin-top: 30px; flex-wrap: wrap; }
        .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; transition: all 0.3s ease; }
        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5a6fd8; transform: translateY(-2px); }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; transform: translateY(-2px); }
        .btn-warning { background: #ffc107; color: #212529; }
        .btn-warning:hover { background: #e0a800; transform: translateY(-2px); }
        .footer { text-align: center; margin-top: 40px; color: white; opacity: 0.8; }
        
        /* Modal Styles */
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); }
        .modal-content { background-color: white; margin: 5% auto; padding: 0; border-radius: 15px; width: 90%; max-width: 1000px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        .modal-header { padding: 20px 30px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; background: #f8f9fa; border-radius: 15px 15px 0 0; }
        .modal-header h2 { margin: 0; color: #333; }
        .close { color: #aaa; font-size: 28px; font-weight: bold; cursor: pointer; transition: color 0.3s; }
        .close:hover { color: #000; }
        .modal-body { padding: 20px 30px; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .logs-controls { display: flex; gap: 15px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
        .logs-info { color: #666; font-size: 0.9rem; margin-left: auto; }
        .logs-container { background: #1e1e1e; color: #d4d4d4; padding: 20px; border-radius: 10px; font-family: 'Courier New', monospace; font-size: 0.9rem; line-height: 1.4; overflow-y: auto; flex: 1; min-height: 300px; }
        .log-line { margin-bottom: 5px; word-wrap: break-word; }
        .log-line:last-child { margin-bottom: 0; }
        .loading { text-align: center; color: #666; font-style: italic; }
        @media (max-width: 768px) { .header h1 { font-size: 2rem; } .status-header { flex-direction: column; align-items: flex-start; } .version-info { flex-direction: column; } .endpoints-grid { grid-template-columns: 1fr; } .modal-content { margin: 2% auto; width: 95%; } .modal-header, .modal-body { padding: 15px 20px; } .logs-controls { flex-direction: column; align-items: flex-start; } .logs-info { margin-left: 0; margin-top: 10px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Rust Items API</h1>
            <p>Comprehensive API for Rust game items, crafting recipes, and item images</p>
        </div>
        
        <div class="status-card">
            <div class="status-header">
                <h2>Server Status</h2>
                <span class="status-badge ${serverStatus.status >= 5 ? 'status-ready' : 'status-starting'}">
                    ${serverStatus.status >= 5 ? 'Ready' : 'Starting Up'}
                </span>
            </div>
            
            <div class="version-info">
                <div class="version-item">
                    <h3>API Version</h3>
                    <p>1.2.0</p>
                </div>
                <div class="version-item game-version">
                    <h3>Game Version</h3>
                    <p>${gameVersion ? `Build ${gameVersion}` : 'Not Available'}</p>
                </div>
                <div class="version-item">
                    <h3>Server Status</h3>
                    <p>${serverStatus.status}/5</p>
                </div>
                <div class="version-item">
                    <h3>Last Update Check</h3>
                    <p>${serverStatus.lastUpdateCheck.toLocaleString()}</p>
                </div>
            </div>
            
            <p><strong>Status Message:</strong> ${serverStatus.message}</p>
            
            <div class="action-buttons">
                <a href="/api-docs" class="btn btn-primary">📚 API Documentation</a>
                <button onclick="openLogsModal()" class="btn btn-secondary">📋 View Logs</button>
                <button onclick="forceUpdate()" class="btn btn-warning">🔄 Force Update</button>
            </div>
        </div>
        
    </div>
    
    <!-- Logs Modal -->
    <div id="logsModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Server Console Logs</h2>
                <span class="close" onclick="closeLogsModal()">&times;</span>
            </div>
            <div class="modal-body">
                <div class="logs-controls">
                    <button onclick="refreshLogs()" class="btn btn-primary">🔄 Refresh</button>
                    <button onclick="clearLogs()" class="btn btn-secondary">🗑️ Clear</button>
                    <span class="logs-info">Showing last <span id="logCount">100</span> lines</span>
                </div>
                <div id="logsContainer" class="logs-container">
                    <div class="loading">Loading logs...</div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        function forceUpdate() {
            if (confirm('This will force a game update and re-extraction. This may take several minutes. Continue?')) {
                fetch('/api/force-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        alert('Update started! Check the server logs for progress.');
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        alert('Update failed: ' + (data.error || 'Unknown error'));
                    }
                })
                .catch(error => {
                    alert('Error starting update: ' + error.message);
                });
            }
        }
        
        function openLogsModal() {
            document.getElementById('logsModal').style.display = 'block';
            loadLogs();
        }
        
        function closeLogsModal() {
            document.getElementById('logsModal').style.display = 'none';
        }
        
        function loadLogs() {
            const container = document.getElementById('logsContainer');
            container.innerHTML = '<div class="loading">Loading logs...</div>';
            
            fetch('/api/logs?lines=100')
                .then(response => response.json())
                .then(data => {
                    if (data.logs) {
                        displayLogs(data.logs);
                        document.getElementById('logCount').textContent = data.totalLines;
                    } else {
                        container.innerHTML = '<div class="loading">No logs available</div>';
                    }
                })
                .catch(error => {
                    container.innerHTML = '<div class="loading">Error loading logs: ' + error.message + '</div>';
                });
        }
        
        function displayLogs(logs) {
            const container = document.getElementById('logsContainer');
            container.innerHTML = '';
            
            logs.forEach(log => {
                const logLine = document.createElement('div');
                logLine.className = 'log-line';
                logLine.textContent = log;
                container.appendChild(logLine);
            });
            
            // Scroll to bottom
            container.scrollTop = container.scrollHeight;
        }
        
        function refreshLogs() {
            loadLogs();
        }
        
        function clearLogs() {
            document.getElementById('logsContainer').innerHTML = '<div class="loading">Logs cleared</div>';
        }
        
        // Close modal when clicking outside of it
        window.onclick = function(event) {
            const modal = document.getElementById('logsModal');
            if (event.target === modal) {
                closeLogsModal();
            }
        }
        
        // Close modal with Escape key
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
                closeLogsModal();
            }
        });
    </script>
</body>
</html>
    `);
});

/**
 * @swagger
 * /api/force-update:
 *   post:
 *     summary: Force game update and re-extraction
 *     description: Manually trigger a game update and re-extraction process
 *     responses:
 *       200:
 *         description: Update process started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Update process started"
 *       500:
 *         description: Failed to start update
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Update process failed"
 */
app.post('/api/force-update', (req, res) => {
    try {
        // Check if we can access the SteamCMD manager
        if (global.steamManager && typeof global.steamManager.forceExtraction === 'function') {
            // Start the force extraction process in the background
            global.steamManager.forceExtraction().catch(error => {
                console.error('Force extraction failed:', error.message);
            });
            
            res.json({
                success: true,
                message: 'Force extraction started. Check server logs for progress.'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Steam manager not available'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api/logs:
 *   get:
 *     summary: Get server console logs
 *     description: Retrieve recent server console logs for debugging and monitoring
 *     parameters:
 *       - in: query
 *         name: lines
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of recent log lines to return
 *     responses:
 *       200:
 *         description: Server logs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 logs:
 *                   type: array
 *                   items:
 *                     type: string
 *                 totalLines:
 *                   type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Failed to retrieve logs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
app.get('/api/logs', (req, res) => {
    try {
        const lines = parseInt(req.query.lines) || 100;
        
        // Get the last N lines from our captured logs
        const recentLogs = serverLogs.slice(-lines);
        
        // Format logs for display
        const formattedLogs = recentLogs.map(log => {
            const time = new Date(log.timestamp).toLocaleTimeString();
            const level = log.level.toUpperCase().padEnd(5);
            return `[${time}] ${level} ${log.message}`;
        });
        
        res.json({
            logs: formattedLogs,
            totalLines: serverLogs.length,
            recentLines: recentLogs.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Get server health status
 *     description: Get detailed information about the server's health and readiness status
 *     responses:
 *       200:
 *         description: Server health information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: integer
 *                   description: Server readiness status (0-5)
 *                   example: 5
 *                 message:
 *                   type: string
 *                   description: Human-readable status message
 *                   example: "Server ready - all services running and API available"
 *                 details:
 *                   type: object
 *                   description: Additional status details
 *                 uptime:
 *                   type: integer
 *                   description: Server uptime in seconds
 *                   example: 3600
 *                 startTime:
 *                   type: string
 *                   format: date-time
 *                   description: When the server started
 *                 lastUpdate:
 *                   type: string
 *                   format: date-time
 *                   description: When the status was last updated
 *                 ready:
 *                   type: boolean
 *                   description: Whether the server is ready to serve requests
 *                   example: true
 *
 * /ready:
 *   get:
 *     summary: Check server readiness
 *     description: Simple endpoint to check if the server is ready to serve requests
 *     responses:
 *       200:
 *         description: Server is ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ready:
 *                   type: boolean
 *                   example: true
 *                 status:
 *                   type: integer
 *                   example: 5
 *                 message:
 *                   type: string
 *                   example: "Server ready - all services running and API available"
 *       503:
 *         description: Server is not ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ready:
 *                   type: boolean
 *                   example: false
 *                 status:
 *                   type: integer
 *                   example: 3
 *                 message:
 *                   type: string
 *                   example: "Downloading Rust game files - this may take a while"
 *                 details:
 *                   type: object
 *                   description: Additional status details
 *
 * /api/items:
 *   get:
 *     summary: Get all items
 *     description: Retrieve all Rust items with their crafting information
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of items to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of items to skip
 *       - in: query
 *         name: category
 *         schema:
 *           type: integer
 *         description: Filter by item category
 *       - in: query
 *         name: hasCrafting
 *         schema:
 *           type: boolean
 *         description: Filter items that have crafting recipes
 *     responses:
 *       200:
 *         description: List of items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Item'
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 retryAfter:
 *                   type: string
 *                 limit:
 *                   type: number
 *                 remaining:
 *                   type: number
 *                 resetTime:
 *                   type: string
 */
app.get('/api/items', strictLimiter, (req, res) => {
    try {
        let filteredItems = [...itemsData];
        const { limit = 50, offset = 0, category, hasCrafting } = req.query;
        
        // Apply filters
        if (category !== undefined) {
            filteredItems = filteredItems.filter(item => item.category === parseInt(category));
        }
        
        if (hasCrafting !== undefined) {
            const hasCraftingBool = hasCrafting === 'true';
            filteredItems = filteredItems.filter(item => 
                hasCraftingBool ? (item.ingredients && item.ingredients.length > 0) : (!item.ingredients || item.ingredients.length === 0)
            );
        }
        
        const total = filteredItems.length;
        const paginatedItems = filteredItems.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
        
        res.json({
            items: paginatedItems,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/items/{shortname}:
 *   get:
 *     summary: Get specific item
 *     description: Retrieve detailed information about a specific item
 *     parameters:
 *       - in: path
 *         name: shortname
 *         required: true
 *         schema:
 *           type: string
 *         description: Item shortname (e.g., 'pistol.eoka')
 *     responses:
 *       200:
 *         description: Item details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Item'
 *       404:
 *         description: Item not found
 */
app.get('/api/items/:shortname', (req, res) => {
    try {
        const { shortname } = req.params;
        const item = itemsData.find(item => item.shortname === shortname);
        
        if (!item) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/categories:
 *   get:
 *     summary: Get all categories
 *     description: Retrieve all available item categories with their IDs and names
 *     responses:
 *       200:
 *         description: List of categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: number
 *                       name:
 *                         type: string
 *                       count:
 *                         type: number
 */
app.get('/api/categories', (req, res) => {
    try {
        // Get unique categories with counts
        const categoryCounts = {};
        itemsData.forEach(item => {
            if (item.category !== null && item.category !== undefined) {
                if (!categoryCounts[item.category]) {
                    categoryCounts[item.category] = {
                        id: item.category,
                        name: item.categoryName || 'Unknown',
                        count: 0
                    };
                }
                categoryCounts[item.category].count++;
            }
        });

        const categories = Object.values(categoryCounts).sort((a, b) => a.id - b.id);
        
        res.json({
            categories: categories,
            total: categories.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



/**
 * @swagger
 * /api/items/{shortname}/image:
 *   get:
 *     summary: Get item image
 *     description: Redirect to the item's image file
 *     parameters:
 *       - in: path
 *         name: shortname
 *         required: true
 *         schema:
 *           type: string
 *         description: Item shortname (e.g., 'pistol.eoka')
 *     responses:
 *       302:
 *         description: Redirect to image
 *       404:
 *         description: Image not found
 */
app.get('/api/items/:shortname/image', (req, res) => {
    try {
        const { shortname } = req.params;
        const imageUrl = getItemImageUrl(shortname);
        
        if (!imageUrl) {
            return res.status(404).json({ error: 'Item image not found' });
        }
        
        res.redirect(imageUrl);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/version:
 *   get:
 *     summary: Get game file version information
 *     description: Retrieve information about the currently downloaded Rust game files version
 *     responses:
 *       200:
 *         description: Game version information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 buildId:
 *                   type: string
 *                   description: Steam build ID of the downloaded game files
 *                   example: "12345678"
 *                 hasGameFiles:
 *                   type: boolean
 *                   description: Whether game files are currently downloaded
 *                   example: true
 *                 versionFileExists:
 *                   type: boolean
 *                   description: Whether version information is available
 *                   example: true
 *                 lastUpdated:
 *                   type: string
 *                   format: date-time
 *                   description: When the version file was last modified
 *                   example: "2024-01-15T10:30:00.000Z"
 *                 gameDataPath:
 *                   type: string
 *                   description: Path to the game data directory
 *                   example: "/opt/rust-api/game-data"
 *       404:
 *         description: No game files or version information found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "No game files found"
 *                 hasGameFiles:
 *                   type: boolean
 *                   example: false
 */
app.get('/api/version', (req, res) => {
    try {
        const gameDataPath = path.join(process.cwd(), 'game-data');
        const versionFilePath = path.join(gameDataPath, 'version.txt');
        
        // Check if game data directory exists
        const hasGameFiles = fs.existsSync(gameDataPath);
        const versionFileExists = fs.existsSync(versionFilePath);
        
        if (!hasGameFiles || !versionFileExists) {
            return res.status(404).json({
                error: 'No game files or version information found',
                hasGameFiles: hasGameFiles,
                versionFileExists: versionFileExists,
                gameDataPath: gameDataPath
            });
        }
        
        // Read the build ID from version file
        const buildId = fs.readFileSync(versionFilePath, 'utf8').trim();
        
        // Get file stats for last updated time
        const stats = fs.statSync(versionFilePath);
        
        res.json({
            buildId: buildId,
            hasGameFiles: true,
            versionFileExists: true,
            lastUpdated: stats.mtime.toISOString(),
            gameDataPath: gameDataPath
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            hasGameFiles: false,
            versionFileExists: false
        });
    }
});

/**
 * @swagger
 * /api/rate-limit-status:
 *   get:
 *     summary: Get rate limit status
 *     description: Get current rate limit status for the requesting IP
 *     responses:
 *       200:
 *         description: Rate limit status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 limit:
 *                   type: number
 *                   description: Maximum requests allowed
 *                 remaining:
 *                   type: number
 *                   description: Remaining requests
 *                 resetTime:
 *                   type: string
 *                   description: When the rate limit resets
 *                 windowMs:
 *                   type: number
 *                   description: Window size in milliseconds
 */
app.get('/api/rate-limit-status', (req, res) => {
    if (req.rateLimit) {
        res.json({
            limit: req.rateLimit.limit,
            remaining: req.rateLimit.remaining,
            resetTime: new Date(req.rateLimit.resetTime).toISOString(),
            windowMs: req.rateLimit.windowMs
        });
    } else {
        res.json({
            message: 'Rate limit information not available',
            limit: 100,
            remaining: 'unknown',
            resetTime: 'unknown',
            windowMs: 15 * 60 * 1000
        });
    }
});





/**
 * @swagger
 * /api/crafting:
 *   get:
 *     summary: Get crafting items
 *     description: Retrieve all items that have crafting recipes
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of items to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of items to skip
 *     responses:
 *       200:
 *         description: Items with crafting recipes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 retryAfter:
 *                   type: string
 *                 limit:
 *                   type: number
 *                 remaining:
 *                   type: number
 *                 resetTime:
 *                   type: string
 */
app.get('/api/crafting', strictLimiter, (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const craftingItems = itemsData.filter(item => 
            item.ingredients && item.ingredients.length > 0
        );
        
        const total = craftingItems.length;
        const paginatedItems = craftingItems.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
        
        res.json({
            items: paginatedItems,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/images/download-all:
 *   get:
 *     summary: Download all item images
 *     description: Download all available item images as a ZIP file
 *     responses:
 *       200:
 *         description: ZIP file containing all item images
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       500:
 *         description: Error creating ZIP file
 */
app.get('/api/images/download-all', async (req, res) => {
    try {
        // Check if we need to rebuild the ZIP
        if (shouldRebuildZip()) {
            console.log('🔄 ZIP cache invalid, rebuilding...');
            
            // Cancel any existing build
            if (cachedZipPromise) {
                cachedZipPromise = null;
            }
            
            // Build new ZIP
            cachedZipPromise = buildZipArchive();
            cachedZipPath = await cachedZipPromise;
            cachedZipStats = getImagesDirectoryStats();
            cachedZipPromise = null;
            
            console.log('✅ ZIP cache updated');
        } else {
            console.log('📦 Using cached ZIP file');
        }

        // Check if cached ZIP exists
        if (!cachedZipPath || !fs.existsSync(cachedZipPath)) {
            return res.status(500).json({ error: 'ZIP file not available' });
        }

        // Get file stats for headers
        const zipStats = fs.statSync(cachedZipPath);
        
        // Set response headers for ZIP download
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="rust-items-images.zip"');
        res.setHeader('Content-Length', zipStats.size);
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.setHeader('Last-Modified', zipStats.mtime.toUTCString());

        // Stream the cached ZIP file
        const fileStream = fs.createReadStream(cachedZipPath);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('❌ Error streaming ZIP file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream ZIP file' });
            }
        });

        fileStream.on('end', () => {
            console.log('📤 ZIP file sent successfully');
        });

    } catch (error) {
        console.error('❌ Error in download-all route:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to download images' });
        }
    }
});

/**
 * @swagger
 * /api/images/cache-status:
 *   get:
 *     summary: Get ZIP cache status
 *     description: Get information about the cached ZIP file
 *     responses:
 *       200:
 *         description: Cache status information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 */
app.get('/api/images/cache-status', (req, res) => {
    try {
        const currentStats = getImagesDirectoryStats();
        const cacheInfo = {
            hasCache: !!cachedZipPath && fs.existsSync(cachedZipPath),
            cachePath: cachedZipPath,
            cacheStats: cachedZipStats,
            currentStats: currentStats,
            needsRebuild: shouldRebuildZip(),
            cacheSize: cachedZipPath && fs.existsSync(cachedZipPath) ? fs.statSync(cachedZipPath).size : null,
            lastModified: cachedZipPath && fs.existsSync(cachedZipPath) ? fs.statSync(cachedZipPath).mtime : null
        };
        
        res.json(cacheInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// Serve Swagger JSON
app.get('/api-docs/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(specs);
});

// Serve Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, {
    swaggerOptions: {
        url: '/api-docs/swagger.json',
        validatorUrl: null,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        showRequestHeaders: true,
        showCommonExtensions: true,
        tryItOutEnabled: true
    },
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Rust Items API Documentation'
}));

// Serve item images (after API routes to avoid conflicts)
app.use('/game-data/Bundles/items', express.static('game-data/Bundles/items'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    addLogEntry(`🚀 Rust Items API server running on http://localhost:${PORT}`);
    addLogEntry(`📚 Swagger documentation available at http://localhost:${PORT}/api-docs`);
    addLogEntry(`📊 Loaded ${itemsData.length} items from processed data`);
});

module.exports = app;
