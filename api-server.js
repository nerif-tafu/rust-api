const express = require('express');
const swaggerJsdoc = require('swagger-jsdoc');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { GAME_DATA_DIR, gameDataPath: resolveGameDataPath, PROCESSED_DATA_DIR } = require('./game-data-path');

const app = express();
const PORT = process.env.PORT || 3100;

// Trust proxy headers for correct client IP behind reverse proxies (e.g., Cloudflare, nginx)
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

// SSE clients for live log streaming (Set of res objects)
const logStreamClients = new Set();

function formatLogLine(log) {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const level = log.level.toUpperCase().padEnd(5);
    return `[${time}] ${level} ${log.message}`;
}

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
    
    // Push new log to all SSE clients (live update)
    const formatted = formatLogLine(logEntry);
    for (const res of logStreamClients) {
        try {
            res.write(`data: ${JSON.stringify({ log: formatted })}\n\n`);
        } catch (err) {
            logStreamClients.delete(res);
        }
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

// Static assets for the single-page docs (app.css, app.js)
app.use(express.static(path.join(__dirname, 'public')));

// Security headers middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Authentication for the log endpoints.
//
// console.log is overridden below to capture every line into an in-memory
// buffer, and SteamCMD's piped stdout flows into it too. That buffer therefore
// carries operational detail — install paths, account identifiers, Steam's own
// login output — which should not be readable by anyone who can reach the port.
//
// This fails closed on purpose: with no LOGS_API_KEY set the endpoints return
// 503 rather than silently serving the buffer to everyone, because the failure
// mode of forgetting to configure it should be a broken debug view, not a
// quiet disclosure.
const LOGS_API_KEY = (process.env.LOGS_API_KEY || '').trim();

// timingSafeEqual throws unless both buffers are the same length, so the two
// sides have to be reduced to a fixed width first. HMAC under a key generated
// fresh each boot does that: an attacker cannot precompute or compare digests
// across requests, and the comparison stays constant-time regardless of how
// long a wrong key is.
//
// A plain hash would work equally well cryptographically here — these are
// high-entropy tokens, not passwords — but it reads as password hashing to
// static analysis. HMAC states the intent (authenticating a token) rather than
// inviting the question.
const COMPARE_KEY = crypto.randomBytes(32);

function constantTimeEquals(a, b) {
    const da = crypto.createHmac('sha256', COMPARE_KEY).update(String(a)).digest();
    const db = crypto.createHmac('sha256', COMPARE_KEY).update(String(b)).digest();
    return crypto.timingSafeEqual(da, db);
}

function requireLogsAuth(req, res, next) {
    if (!LOGS_API_KEY) {
        return res.status(503).json({
            error: 'Log access is not configured. Set LOGS_API_KEY to enable /api/logs.'
        });
    }

    const header = req.get('authorization') || '';
    const supplied = header.startsWith('Bearer ')
        ? header.slice(7)
        : String(req.query.key || '');

    if (!constantTimeEquals(supplied, LOGS_API_KEY)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// Covers /api/logs and /api/logs/stream by prefix. /debug/status is included
// because it serves logs/app.log and logs/error.log straight off disk — the
// same disclosure by a different route, so gating only one of them would leave
// the door open.
app.use('/api/logs', requireLogsAuth);
app.use('/debug/status', requireLogsAuth);

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
            version: '1.4.4',
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
        const itemsPath = path.join(PROCESSED_DATA_DIR, 'rust_items.json');
        
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
const itemsDataPath = path.join(PROCESSED_DATA_DIR, 'rust_items.json');
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
    const imagePath = resolveGameDataPath('Bundles', 'items', `${shortname}.png`);
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
    const imagesDir = resolveGameDataPath('Bundles', 'items');
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
    const imagesDir = resolveGameDataPath('Bundles', 'items');
    
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
    const cacheDir = path.join(PROCESSED_DATA_DIR, 'cache');
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
    const escapeHtml = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    let gameVersion = null;
    try {
        const versionFilePath = resolveGameDataPath('version.txt');
        if (fs.existsSync(versionFilePath)) gameVersion = fs.readFileSync(versionFilePath, 'utf8').trim();
    } catch (error) {
        console.warn('Could not read game version:', error.message);
    }

    const status = serverStatus.status || 1;
    const ready = status >= 5;
    const apiVersion = (specs && specs.info && specs.info.version) || '';
    const lastCheck = serverStatus.lastUpdateCheck
        ? new Date(serverStatus.lastUpdateCheck).toLocaleString() : 'Never';
    const message = serverStatus.message || '';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rust Items API</title>
    <link rel="stylesheet" href="/app.css">
</head>
<body>
    <main class="page">
        <header class="page-header">
            <h1 class="page-title">Rust Items API</h1>
            <p class="page-description">Item data, crafting recipes and images extracted from Rust game files.</p>
        </header>

        <section class="section">
            <div class="section-head">
                <div>
                    <h2 class="section-title">Status</h2>
                    <p class="section-description">${escapeHtml(message)}</p>
                </div>
                <div class="section-actions">
                    <button class="btn btn-sm" id="openLogsBtn">View logs</button>
                    <button class="btn btn-sm" id="forceUpdateBtn">Force update</button>
                </div>
            </div>
            <dl class="detail-grid">
                <div><dt>Server</dt><dd><span class="status-pill ${ready ? 'is-ok' : 'is-warn'}">${ready ? 'Ready' : 'Starting'}</span> ${status}/5</dd></div>
                <div><dt>API version</dt><dd>${escapeHtml(apiVersion)}</dd></div>
                <div><dt>Game version</dt><dd>${gameVersion ? 'Build ' + escapeHtml(gameVersion) : 'Not available'}</dd></div>
                <div><dt>Last update check</dt><dd>${escapeHtml(lastCheck)}</dd></div>
            </dl>
        </section>

        <section class="section">
            <div class="section-head">
                <div>
                    <h2 class="section-title">API Reference</h2>
                    <p class="section-description">Every endpoint, generated from the OpenAPI spec. <a href="/api-docs/swagger.json">Raw spec</a>.</p>
                </div>
                <div class="section-actions"><span class="section-description" id="endpointCount"></span></div>
            </div>
            <div class="ref-controls">
                <input type="text" id="refFilter" class="ref-filter" placeholder="Filter endpoints by path, method or description...">
            </div>
            <div id="apiReference"></div>
        </section>
    </main>

    <div class="modal" id="logsModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Server Logs</h2>
                <span class="modal-close" id="closeLogsBtn" title="Close">&times;</span>
            </div>
            <div class="modal-body">
                <div class="logs-controls">
                    <button class="btn btn-sm" id="refreshLogsBtn">Refresh</button>
                    <span class="logs-info">Showing last <span id="logCount">100</span> lines</span>
                </div>
                <div class="logs-container" id="logsContainer"><div class="muted-note">Loading logs...</div></div>
            </div>
        </div>
    </div>

    <script src="/app.js"></script>
</body>
</html>`);
});

/**
 * @swagger
 * /api/update-status:
 *   get:
 *     summary: Check if game files need an update (Steam UpToDateCheck)
 *     description: Uses Steam UpToDateCheck API to determine if a force update is needed
 *     responses:
 *       200:
 *         description: Update status from Steam
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 needUpdate:
 *                   type: boolean
 *                 upToDate:
 *                   type: boolean
 *                 currentVersion:
 *                   type: integer
 *                   nullable: true
 *                 requiredVersion:
 *                   type: integer
 *                   nullable: true
 *                 message:
 *                   type: string
 *                   nullable: true
 */
app.get('/api/update-status', async (req, res) => {
    try {
        if (!global.steamManager || typeof global.steamManager.checkSteamUpToDate !== 'function') {
            return res.status(503).json({
                error: 'Steam manager or UpToDateCheck not available',
                needUpdate: true
            });
        }
        const result = await global.steamManager.checkSteamUpToDate();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            error: error.message,
            needUpdate: true
        });
    }
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
app.post('/api/force-update', async (req, res) => {
    try {
        // Check if we can access the SteamCMD manager
        if (!global.steamManager || typeof global.steamManager.forceExtraction !== 'function') {
            return res.status(500).json({
                success: false,
                error: 'Steam manager not available'
            });
        }
        // Force update always runs full extraction regardless of UpToDateCheck
        global.steamManager.forceExtraction().catch(error => {
            console.error('Force extraction failed:', error.message);
        });
        res.json({
            success: true,
            message: 'Force extraction started. Check server logs for progress.'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Server-Sent Events stream for live log updates
app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx
    res.flushHeaders();
    logStreamClients.add(res);
    const keepAlive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch (err) {
            clearInterval(keepAlive);
            logStreamClients.delete(res);
        }
    }, 30000);
    req.on('close', () => {
        clearInterval(keepAlive);
        logStreamClients.delete(res);
    });
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
        const formattedLogs = recentLogs.map(log => formatLogLine(log));
        
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
 */
app.get('/api/items', (req, res) => {
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
        const versionFilePath = resolveGameDataPath('version.txt');

        // Check if game data directory exists
        const hasGameFiles = fs.existsSync(GAME_DATA_DIR);
        const versionFileExists = fs.existsSync(versionFilePath);
        
        if (!hasGameFiles || !versionFileExists) {
            return res.status(404).json({
                error: 'No game files or version information found',
                hasGameFiles: hasGameFiles,
                versionFileExists: versionFileExists,
                gameDataPath: GAME_DATA_DIR
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
 */
app.get('/api/crafting', (req, res) => {
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



// Serve the OpenAPI spec (machine-readable). The human docs live on the
// unified home page, which renders this spec in the house style.
app.get('/api-docs/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(specs);
});

// The Swagger UI page was replaced by the unified home page; keep the old
// path working by redirecting to it.
app.get('/api-docs', (req, res) => res.redirect('/'));

// Serve item images (after API routes to avoid conflicts). The URL path is
// fixed (/game-data/...) regardless of where GAME_DATA_DIR actually points.
app.use('/game-data/Bundles/items', express.static(resolveGameDataPath('Bundles', 'items')));

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
