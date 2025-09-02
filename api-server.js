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

// Server readiness status
let serverStatus = {
    status: 0, // 0: Not started, 1: Basic setup, 2: Steam setup, 3: Game downloading, 4: AssetRipper setup, 5: Ready
    message: 'Server starting up...',
    details: {},
    startTime: new Date(),
    lastUpdate: new Date()
};

function updateStatus(status, message, details = {}) {
    serverStatus.status = status;
    serverStatus.message = message;
    serverStatus.details = details;
    serverStatus.lastUpdate = new Date();
    console.log(`🔄 Status ${status}: ${message}`);
}

// Make updateStatus available globally for index.js
global.serverStatus = global.serverStatus || {};
global.serverStatus.updateStatus = updateStatus;

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
            message: serverStatus.message
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
            version: '1.0.0',
            description: 'API for Rust game items, crafting recipes, and item images',
            contact: {
                name: 'Rust Items Extractor',
                url: 'https://github.com/nerif-tafu/rust-api'
            }
        },
        servers: [
            {
                url: process.env.API_BASE_URL || `http://localhost:${PORT}`,
                description: 'Development server'
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
            console.log(`✅ Loaded ${itemsData.length} items from rust_items.json`);
        } else {
            console.log('⚠️  rust_items.json not found, items data will be empty');
        }
    } catch (error) {
        console.error('❌ Error loading items data:', error.message);
        itemsData = [];
    }
}

// Initial load
loadItemsData();

// Watch for changes to rust_items.json and reload automatically
const itemsDataPath = path.join(__dirname, 'processed-data', 'rust_items.json');
if (fs.existsSync(itemsDataPath)) {
    console.log('👀 Watching for changes to rust_items.json...');
    
    // Use fs.watch for file monitoring (works on Linux)
    fs.watch(itemsDataPath, (eventType, filename) => {
        if (eventType === 'change' && filename === 'rust_items.json') {
            console.log('🔄 rust_items.json changed, reloading data...');
            // Small delay to ensure file write is complete
            setTimeout(() => {
                loadItemsData();
                console.log('✅ Items data reloaded successfully');
            }, 1000);
        }
    });
    
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
}

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
    res.json({
        message: 'Rust Items API',
        version: '1.0.0',
        status: serverStatus.status >= 5 ? 'ready' : 'starting up',
        readiness: {
            status: serverStatus.status,
            message: serverStatus.message,
            ready: serverStatus.status >= 5
        },
        endpoints: [
            'GET /health - Get detailed server health status',
            'GET /ready - Check if server is ready to serve requests',
            'GET /api/items - Get all items with crafting information',
            'GET /api/items/:shortname - Get specific item details',
            'GET /api/items/:shortname/image - Get item image',
            'GET /api/categories - Get all available item categories',
            'GET /api/rate-limit-status - Get current rate limit status',
            'GET /api/images/download-all - Download all item images as ZIP (cached)',
            'GET /api/images/cache-status - Get ZIP cache status'
        ],
        rateLimits: {
            general: '10,000 requests per 15 minutes',
            strict: '3,000 requests per 15 minutes (items)'
        }
    });
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



// Serve Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

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
    console.log(`🚀 Rust Items API server running on http://localhost:${PORT}`);
    console.log(`📚 Swagger documentation available at http://localhost:${PORT}/api-docs`);
    console.log(`📊 Loaded ${itemsData.length} items from processed data`);
});

module.exports = app;
