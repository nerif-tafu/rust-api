const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const { execSync } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

class AssetRipperManager {
    constructor(port = 54691) {
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${port}`;
        this.axios = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000
        });
        this.assetRipperProcess = null;
        
        // Setup configuration
        this.version = '1.3.2';
        this.downloadUrls = {
            'linux': `https://github.com/AssetRipper/AssetRipper/releases/download/${this.version}/AssetRipper_linux_x64.zip`,
            'darwin': `https://github.com/AssetRipper/AssetRipper/releases/download/${this.version}/AssetRipper_mac_arm64.zip`,
            'win32': `https://github.com/AssetRipper/AssetRipper/releases/download/${this.version}/AssetRipper_win_x64.zip`
        };
        
        this.directories = {
            assetRipper: 'asset-ripper',
            exportData: 'export-data',
            processedData: 'processed-data',
            gameData: 'game-data'
        };
        
        // Additional subdirectories that need to be created
        this.subDirectories = {
            logs: 'asset-ripper/logs'
        };
        
        // Rust item category mapping
        this.categoryMap = {
            0: 'Weapon',
            1: 'Construction',
            2: 'Items',
            3: 'Resources',
            4: 'Attire',
            5: 'Tool',
            6: 'Medical',
            7: 'Food',
            8: 'Ammunition',
            9: 'Traps',
            10: 'Misc',
            13: 'Deployable',
            14: 'Component',
            16: 'Vehicle',
            17: 'Electrical'
        };
    }

    // ===== SETUP METHODS =====

    getOS() {
        return process.platform;
    }

    getDownloadUrl() {
        const os = this.getOS();
        const url = this.downloadUrls[os];
        
        if (!url) {
            throw new Error(`Unsupported operating system: ${os}`);
        }
        
        return url;
    }

    async downloadFile(url, destination) {
        console.log(`Downloading AssetRipper from: ${url}`);
        console.log(`Destination: ${destination}`);
        
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destination);
            
            const request = https.get(url, (response) => {
                // Handle redirects
                if (response.statusCode === 301 || response.statusCode === 302) {
                    const newUrl = response.headers.location;
                    console.log(`Redirecting to: ${newUrl}`);
                    file.close();
                    fs.unlinkSync(destination);
                    this.downloadFile(newUrl, destination).then(resolve).catch(reject);
                    return;
                }
                
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
                    return;
                }
                
                const totalSize = parseInt(response.headers['content-length'], 10);
                let downloadedSize = 0;
                
                response.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    if (totalSize) {
                        const progress = ((downloadedSize / totalSize) * 100).toFixed(2);
                        process.stdout.write(`\rDownload progress: ${progress}%`);
                    } else {
                        process.stdout.write(`\rDownloaded: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`);
                    }
                });
                
                pipeline(response, file, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        console.log('\nDownload completed successfully!');
                        resolve();
                    }
                });
            });
            
            request.on('error', reject);
        });
    }

    async extractZip(zipPath, extractPath) {
        console.log(`Extracting AssetRipper to: ${extractPath}`);
        
        try {
            // Check if unzip is available
            if (process.platform !== 'win32') {
                try {
                    execSync('which unzip', { stdio: 'pipe' });
                } catch (error) {
                    throw new Error('unzip command not found. Please install unzip package.');
                }
                
                console.log('Using unzip command for extraction...');
                execSync(`unzip -o "${zipPath}" -d "${extractPath}"`, { stdio: 'inherit' });
            } else {
                // On Windows, we'll need to use a different approach
                // For now, we'll use PowerShell's Expand-Archive
                execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`, { stdio: 'inherit' });
            }
            
            // Verify extraction succeeded by checking for expected files
            const expectedFiles = ['AssetRipper.GUI.Free', 'AssetRipper.GUI.Free.exe'];
            const hasExecutable = expectedFiles.some(file => fs.existsSync(path.join(extractPath, file)));
            
            if (!hasExecutable) {
                throw new Error('Extraction completed but expected files not found. Extraction may have failed.');
            }
            
            console.log('Extraction completed successfully!');
            console.log(`Extracted files: ${fs.readdirSync(extractPath).join(', ')}`);
            
        } catch (error) {
            console.error(`❌ Extraction failed: ${error.message}`);
            console.error('This will prevent AssetRipper from working properly.');
            throw new Error(`Failed to extract zip file: ${error.message}`);
        }
    }

    createDirectories() {
        console.log('Creating directory structure...');
        
        // Create main directories
        for (const [name, dir] of Object.entries(this.directories)) {
            const fullPath = path.resolve(dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`Created directory: ${fullPath}`);
            } else {
                console.log(`Directory already exists: ${fullPath}`);
            }
        }
        
        // Create subdirectories
        for (const [name, dir] of Object.entries(this.subDirectories)) {
            const fullPath = path.resolve(dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`Created directory: ${fullPath}`);
            } else {
                console.log(`Directory already exists: ${fullPath}`);
            }
        }
    }

    async setupAssetRipper() {
        const os = this.getOS();
        const downloadUrl = this.getDownloadUrl();
        const assetRipperDir = path.resolve(this.directories.assetRipper);
        const zipPath = path.join(assetRipperDir, `AssetRipper_${this.version}.zip`);
        
        // Create asset-ripper directory
        if (!fs.existsSync(assetRipperDir)) {
            fs.mkdirSync(assetRipperDir, { recursive: true });
        }
        
        // Check if AssetRipper is already downloaded and extracted
        const executableName = os === 'win32' ? 'AssetRipper.GUI.Free.exe' : 'AssetRipper.GUI.Free';
        const executablePath = path.join(assetRipperDir, executableName);
        
        if (fs.existsSync(executablePath)) {
            console.log(`AssetRipper already exists at: ${executablePath}`);
            return executablePath;
        }
        
        // Download AssetRipper
        await this.downloadFile(downloadUrl, zipPath);
        
        // Extract the zip file
        await this.extractZip(zipPath, assetRipperDir);
        
        // Clean up the zip file
        fs.unlinkSync(zipPath);
        console.log('Cleaned up downloaded zip file');
        
        // Verify the executable exists
        if (!fs.existsSync(executablePath)) {
            throw new Error(`AssetRipper executable not found at expected path: ${executablePath}`);
        }
        
        // Check if the file is actually a file (not a directory)
        const stats = fs.statSync(executablePath);
        if (!stats.isFile()) {
            throw new Error(`AssetRipper executable path exists but is not a file: ${executablePath}`);
        }
        
        // Make executable on Unix-like systems
        if (os !== 'win32') {
            try {
                fs.chmodSync(executablePath, '755');
                console.log('Made AssetRipper executable');
            } catch (error) {
                console.warn(`Warning: Could not make AssetRipper executable: ${error.message}`);
            }
        }
        
        console.log(`AssetRipper setup completed: ${executablePath}`);
        console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        return executablePath;
    }

    async checkAssetRipperSetup() {
        const os = this.getOS();
        const executableName = os === 'win32' ? 'AssetRipper.GUI.Free.exe' : 'AssetRipper.GUI.Free';
        const assetRipperPath = path.join(process.cwd(), 'asset-ripper', executableName);
        
        if (!fs.existsSync(assetRipperPath)) {
            console.log('\n🔧 AssetRipper not found. Setting up automatically...');
            
            try {
                // Create directories first
                this.createDirectories();
                
                // Setup AssetRipper
                await this.setupAssetRipper();
                
                console.log('✅ AssetRipper setup completed successfully!');
                
                // Verify the executable now exists
                if (!fs.existsSync(assetRipperPath)) {
                    throw new Error('AssetRipper setup completed but executable not found');
                }
                
            } catch (error) {
                console.error('\n❌ Automatic setup failed:', error.message);
                console.error('\nPlease run "npm run setup" manually to fix this issue.\n');
                throw new Error(`AssetRipper setup failed: ${error.message}`);
            }
        }
        
        return assetRipperPath;
    }

    checkBundleFile() {
        // Look for bundle file in game-data directory
        let bundlePath = path.resolve('./game-data/Bundles/shared/items.preload.bundle');
        
        if (!fs.existsSync(bundlePath)) {
            console.error('\n❌ Bundle file not found!');
            console.error('Expected location: game-data/Bundles/shared/items.preload.bundle');
            console.error('\nPlease place your Rust bundle file (items.preload.bundle) in the game-data/Bundles/shared directory.');
            console.error('You can find this file in your Rust game installation.\n');
            throw new Error('Bundle file not found. Please place your items.preload.bundle file in the game-data/Bundles/shared directory.');
        }
        
        return bundlePath;
    }

    // ===== ASSETRIPPER OPERATIONS =====

    async startAssetRipper() {
        console.log('Checking if AssetRipper is already running...');
        
        // First, try to connect to an existing AssetRipper instance
        try {
            const response = await this.axios.get('/', { timeout: 3000 });
            if (response.status === 200) {
                console.log('AssetRipper is already running and accessible!');
                return null; // No need to start a new process
            }
        } catch (error) {
            console.log('AssetRipper not accessible, starting new instance...');
        }
        
        // Check if AssetRipper is properly set up
        const assetRipperPath = await this.checkAssetRipperSetup();
        
        // Create logs directory
        const logsDir = path.join(process.cwd(), 'asset-ripper', 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        
        // Generate log filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFilename = `AssetRipper_${timestamp}.log`;
        const logPath = path.join(logsDir, logFilename);
        
        return new Promise((resolve) => {
            this.assetRipperProcess = spawn(assetRipperPath, [
                '--port', this.port.toString(),
                '--log-path', logPath
            ], {
                cwd: path.dirname(assetRipperPath),
                stdio: 'pipe'
            });

            this.assetRipperProcess.stdout.on('data', (data) => {
                const output = data.toString().trim();
                if (output.includes('Now listening on:')) {
                    console.log('AssetRipper is starting up...');
                }
            });

            this.assetRipperProcess.stderr.on('data', (data) => {
                console.log(`AssetRipper stderr: ${data}`);
            });

            this.assetRipperProcess.on('close', (code) => {
                console.log(`AssetRipper process exited with code ${code}`);
            });

            setTimeout(() => resolve(this.assetRipperProcess), 5000);
        });
    }

    async waitForAssetRipper() {
        console.log('Waiting for AssetRipper to be ready...');
        
        for (let i = 0; i < 60; i++) {
            try {
                const response = await this.axios.get('/', { timeout: 5000 });
                if (response.status === 200) {
                    console.log('AssetRipper is ready!');
                    return true;
                }
            } catch (error) {
                if (i % 10 === 0) {
                    console.log(`Attempt ${i + 1}/60: AssetRipper not ready yet...`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        throw new Error('AssetRipper failed to start within 60 seconds');
    }

    async loadBundle(bundlePath) {
        console.log(`Loading bundle: ${bundlePath}`);
        
        if (!fs.existsSync(bundlePath)) {
            throw new Error(`Bundle file not found: ${bundlePath}`);
        }
        
        try {
            // Use URLSearchParams instead of FormData for proper encoding
            const params = new URLSearchParams();
            params.append('path', bundlePath);
            
            const response = await this.axios.post('/LoadFile', params, {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                maxRedirects: 0,
                validateStatus: (status) => status === 302
            });
            
            console.log('Bundle loaded successfully');
            await new Promise(resolve => setTimeout(resolve, 3000));
            return true;
        } catch (error) {
            console.error('Failed to load bundle:', error.message);
            throw error;
        }
    }

    async exportProject() {
        console.log('Exporting Unity project...');
        
        const exportPath = path.join(process.cwd(), 'export-data');
        
        // Create export directory if it doesn't exist
        if (!fs.existsSync(exportPath)) {
            fs.mkdirSync(exportPath, { recursive: true });
        }
        
        try {
            // Use the Export/UnityProject endpoint
            const params = new URLSearchParams();
            params.append('path', exportPath);
            
            const response = await this.axios.post('/Export/UnityProject', params, {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                maxRedirects: 0,
                validateStatus: (status) => status === 302
            });
            
            console.log('Project exported successfully');
            return exportPath;
        } catch (error) {
            console.error('Failed to export project:', error.message);
            throw error;
        }
    }

    // ===== DATA EXTRACTION METHODS =====

    async extractAllItems() {
        console.log('Extracting all items...');
        
        // Update status to indicate AssetRipper extraction
        if (global.serverStatus && global.serverStatus.updateStatus) {
            global.serverStatus.updateStatus(4, 'AssetRipper extraction in progress - loading bundle and extracting items', {
                stage: 'extraction',
                substage: 'starting'
            });
        }
        
        // First export the project
        const exportPath = await this.exportProject();
        
        // Look for prefab files in the exported project
        const prefabsPath = path.join(exportPath, 'ExportedProject', 'Assets', 'prefabs');
        
        if (!fs.existsSync(prefabsPath)) {
            console.log('No prefabs directory found in exported project');
            return { items: [], blueprints: [] };
        }
        
        console.log(`Scanning for prefab files in: ${prefabsPath}`);
        
        const items = [];
        const blueprints = [];
        
        // Recursively find all .prefab files
        const prefabFiles = this.findPrefabFiles(prefabsPath);
        console.log(`Found ${prefabFiles.length} prefab files`);
        
        for (let i = 0; i < prefabFiles.length; i++) {
            const prefabFile = prefabFiles[i];
            
            if (i % 50 === 0) {
                console.log(`Processing prefab ${i + 1}/${prefabFiles.length}: ${path.basename(prefabFile)}`);
            }
            
            try {
                const prefabContent = fs.readFileSync(prefabFile, 'utf8');
                const itemInfos = this.parsePrefabFile(prefabContent, prefabFile);
                
                if (itemInfos) {
                    for (const itemInfo of itemInfos) {
                        if (itemInfo.type === 'ItemDefinition') {
                            items.push(itemInfo);
                        } else if (itemInfo.type === 'ItemBlueprint') {
                            blueprints.push(itemInfo);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error processing ${prefabFile}:`, error.message);
            }
        }
        
        console.log(`Extracted ${items.length} items and ${blueprints.length} blueprints from prefabs`);
        
        // Also process JSON item definition files from game-data
        const jsonItems = await this.extractJsonItems();
        console.log(`Extracted ${jsonItems.length} additional items from JSON files`);
        
        // Merge items, prioritizing JSON data over prefab data
        // First, update existing items with JSON data if available
        const jsonItemsMap = new Map(jsonItems.map(item => [item.itemid, item]));
        const updatedItems = items.map(item => {
            const jsonItem = jsonItemsMap.get(item.itemid);
            if (jsonItem) {
                // JSON data exists, use it to update display name and other fields
                return { ...item, ...jsonItem };
            }
            return item;
        });
        
        // Then, add new items that don't exist in prefab data
        const existingItemIds = new Set(updatedItems.map(item => item.itemid));
        const newJsonItems = jsonItems.filter(item => !existingItemIds.has(item.itemid));
        const allItems = [...updatedItems, ...newJsonItems];
        
        console.log(`Total items after merging: ${allItems.length}`);
        
        // Update status to indicate extraction completed
        if (global.serverStatus && global.serverStatus.updateStatus) {
            global.serverStatus.updateStatus(5, 'AssetRipper extraction completed - server ready to serve requests', {
                stage: 'extraction_complete',
                itemsCount: allItems.length,
                blueprintsCount: blueprints.length
            });
        }
        
        return { items: allItems, blueprints };
    }

    async extractJsonItems() {
        console.log('Extracting items from JSON definition files...');
        
        const itemsPath = path.join(this.directories.gameData, 'Bundles', 'items');
        
        if (!fs.existsSync(itemsPath)) {
            console.log('No items directory found in game-data');
            return [];
        }
        
        const jsonFiles = fs.readdirSync(itemsPath).filter(file => file.endsWith('.json'));
        console.log(`Found ${jsonFiles.length} JSON item definition files`);
        
        const items = [];
        
        for (let i = 0; i < jsonFiles.length; i++) {
            const jsonFile = jsonFiles[i];
            
            if (i % 100 === 0) {
                console.log(`Processing JSON file ${i + 1}/${jsonFiles.length}: ${jsonFile}`);
            }
            
            try {
                const filePath = path.join(itemsPath, jsonFile);
                const content = fs.readFileSync(filePath, 'utf8');
                const itemData = JSON.parse(content);
                
                // Convert JSON item data to the same format as prefab items
                if (itemData.itemid && itemData.shortname && itemData.Name) {
                    const item = {
                        itemid: itemData.itemid,
                        shortname: itemData.shortname,
                        displayName: itemData.Name,
                        description: itemData.Description || '',
                        category: this.categoryMap[itemData.Category] || 'Unknown',
                        categoryId: itemData.Category,
                        stackable: itemData.stackable || 1,
                        volume: itemData.volume || 0,
                        maxDraggable: itemData.maxDraggable || 0,
                        itemType: itemData.ItemType || 'Generic',
                        amountType: itemData.AmountType || 'Count',
                        quickDespawn: itemData.quickDespawn || false,
                        rarity: itemData.rarity || 'None',
                        condition: itemData.condition || null,
                        parent: itemData.Parent || 0,
                        isWearable: itemData.isWearable || false,
                        isHoldable: itemData.isHoldable || false,
                        isUsable: itemData.isUsable || false,
                        hasSkins: itemData.HasSkins || false,
                        ingredients: [], // JSON files don't contain crafting recipes
                        craftTime: 0,
                        amountToCreate: 1,
                        workbenchLevel: 0,
                        source: 'json' // Mark as coming from JSON files
                    };
                    
                    items.push(item);
                }
            } catch (error) {
                console.error(`Error processing JSON file ${jsonFile}:`, error.message);
            }
        }
        
        return items;
    }

    findPrefabFiles(dir) {
        const prefabFiles = [];
        
        if (!fs.existsSync(dir)) {
            return prefabFiles;
        }
        
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            
            if (stat.isDirectory()) {
                prefabFiles.push(...this.findPrefabFiles(filePath));
            } else if (file.endsWith('.prefab')) {
                prefabFiles.push(filePath);
            }
        }
        
        return prefabFiles;
    }

    parsePrefabFile(content, filePath) {
        try {
            const results = [];
            
            // Look for ItemDefinition data in the prefab content
            const itemidMatch = content.match(/itemid:\s*([^\r\n]+)/);
            const shortnameMatch = content.match(/shortname:\s*([^\r\n]+)/);
            const displayNameMatch = content.match(/displayName:[\s\S]*?token:\s*([^\r\n]+)/);
            
            if (itemidMatch && shortnameMatch && displayNameMatch) {
                const itemid = parseInt(itemidMatch[1].trim());
                const shortname = shortnameMatch[1].trim();
                let displayName = displayNameMatch[1].trim();
                
                // Extract additional fields
                const categoryMatch = content.match(/category:\s*([^\r\n]+)/);
                const stackableMatch = content.match(/stackable:\s*([^\r\n]+)/);
                const volumeMatch = content.match(/volume:\s*([^\r\n]+)/);
                
                let category = categoryMatch ? parseInt(categoryMatch[1].trim()) : null;
                const stackable = stackableMatch ? parseInt(stackableMatch[1].trim()) : null;
                const volume = volumeMatch ? parseInt(volumeMatch[1].trim()) : null;
                
                // Special handling for blueprint fragments
                if (shortname === 'basicblueprintfragment' || shortname === 'advancedblueprintfragment') {
                    displayName = shortname === 'basicblueprintfragment' ? 'Basic Blueprint Fragment' : 'Advanced Blueprint Fragment';
                    category = 14; // Use a custom category for Component
                }
                
                // Extract pathID from the MonoBehaviour line
                const pathIDMatch = content.match(/!u!114 &(\d+)/);
                const pathId = pathIDMatch ? parseInt(pathIDMatch[1]) : null;
                
                results.push({
                    type: 'ItemDefinition',
                    pathId: pathId,
                    shortname: shortname,
                    displayName: displayName,
                    itemid: itemid,
                    category: category,
                    categoryName: category !== null ? this.categoryMap[category] || 'Unknown' : null,
                    stackable: stackable,
                    volume: volume,
                    ingredients: [],
                    craftTime: null,
                    amountToCreate: null,
                    workbenchLevelRequired: null,
                    sourceFile: path.basename(filePath)
                });
            }
            
            // Look for ItemBlueprint data (crafting recipes)
            const ingredientsMatch = content.match(/ingredients:/);
            const timeMatch = content.match(/time:\s*([^\r\n]+)/);
            const amountToCreateMatch = content.match(/amountToCreate:\s*([^\r\n]+)/);
            const workbenchLevelMatch = content.match(/workbenchLevelRequired:\s*([^\r\n]+)/);
            
            if (ingredientsMatch && timeMatch && amountToCreateMatch) {
                const time = parseFloat(timeMatch[1].trim());
                const amountToCreate = parseInt(amountToCreateMatch[1].trim());
                const workbenchLevelRequired = workbenchLevelMatch ? parseInt(workbenchLevelMatch[1].trim()) : null;
                
                // Extract ingredients (simplified parsing for YAML format)
                const ingredients = [];
                const ingredientMatches = content.match(/itemDef:\s*{[^}]+}/g);
                if (ingredientMatches) {
                    for (const ingredientMatch of ingredientMatches) {
                        const fileIDMatch = ingredientMatch.match(/fileID:\s*([^\r\n,}]+)/);
                        if (fileIDMatch) {
                            // Find the amount on the next line after this itemDef
                            const afterItemDef = content.substring(content.indexOf(ingredientMatch) + ingredientMatch.length);
                            const amountMatch = afterItemDef.match(/amount:\s*([^\r\n]+)/);
                            if (amountMatch) {
                                ingredients.push({
                                    amount: parseInt(amountMatch[1].trim()),
                                    itemDef: { 
                                        m_PathID: parseInt(fileIDMatch[1].trim())
                                    }
                                });
                            }
                        }
                    }
                }
                
                results.push({
                    type: 'ItemBlueprint',
                    pathId: null,
                    shortname: shortnameMatch ? shortnameMatch[1].trim() : path.basename(filePath, '.prefab'),
                    displayName: displayNameMatch ? displayNameMatch[1].trim() : path.basename(filePath, '.prefab'),
                    itemid: itemidMatch ? parseInt(itemidMatch[1].trim()) : null,
                    category: null,
                    stackable: null,
                    volume: null,
                    ingredients: ingredients,
                    craftTime: time,
                    amountToCreate: amountToCreate,
                    workbenchLevelRequired: workbenchLevelRequired,
                    sourceFile: path.basename(filePath)
                });
            }
            
            return results.length > 0 ? results : null;
        } catch (error) {
            console.error(`Error parsing prefab file ${filePath}:`, error.message);
            return null;
        }
    }

    matchItemsWithBlueprints(items, blueprints) {
        console.log('Matching items with blueprints...');
        
        // Create a map of items by pathID for ingredient lookup
        const itemPathIDMap = new Map();
        items.forEach(item => {
            if (item.pathId) {
                itemPathIDMap.set(item.pathId, item);
            }
        });
        
        // Create a map of blueprints by shortname
        const blueprintMap = new Map();
        blueprints.forEach(blueprint => {
            blueprintMap.set(blueprint.shortname, blueprint);
        });
        
        // For each item, try to find a matching blueprint
        const result = [];
        for (const item of items) {
            const matchingBlueprint = blueprintMap.get(item.shortname);
            
            if (matchingBlueprint) {
                // Resolve ingredient references to actual items
                const resolvedIngredients = [];
                for (const ingredient of matchingBlueprint.ingredients) {
                    const ingredientItem = itemPathIDMap.get(ingredient.itemDef.m_PathID);
                    if (ingredientItem) {
                        resolvedIngredients.push({
                            amount: ingredient.amount,
                            itemDef: {
                                m_PathID: ingredient.itemDef.m_PathID,
                                shortname: ingredientItem.shortname,
                                displayName: ingredientItem.displayName
                            }
                        });
                    } else {
                        // Keep original if we can't resolve
                        resolvedIngredients.push(ingredient);
                    }
                }
                
                item.ingredients = resolvedIngredients;
                item.craftTime = matchingBlueprint.craftTime;
                item.amountToCreate = matchingBlueprint.amountToCreate;
                item.workbenchLevelRequired = matchingBlueprint.workbenchLevelRequired;
            } else {
                item.ingredients = [];
                item.craftTime = null;
                item.amountToCreate = null;
                item.workbenchLevelRequired = null;
            }
            
            result.push(item);
        }
        
        return result;
    }

    saveToFile(items, filename = 'rust_items.json') {
        // Ensure processed-data directory exists
        const processedDataDir = path.join(process.cwd(), 'processed-data');
        if (!fs.existsSync(processedDataDir)) {
            fs.mkdirSync(processedDataDir, { recursive: true });
        }
        
        const filePath = path.join(processedDataDir, filename);
        const data = JSON.stringify(items, null, 2);
        fs.writeFileSync(filePath, data);
        console.log(`Saved ${items.length} items to ${filePath}`);
        
        // Also create a summary
        const summary = {
            totalItems: items.length,
            itemsWithBlueprints: items.filter(item => item.ingredients.length > 0).length,
            itemsWithoutBlueprints: items.filter(item => item.ingredients.length === 0).length,
            categories: [...new Set(items.map(item => item.category))].sort()
        };
        
        const summaryPath = path.join(processedDataDir, 'extraction_summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
        console.log(`Saved extraction summary to ${summaryPath}`);
    }

    // ===== CLEANUP METHODS =====

    async cleanup() {
        if (this.assetRipperProcess) {
            console.log('Stopping AssetRipper...');
            this.assetRipperProcess.kill();
        }
    }

    // ===== MAIN EXTRACTION METHOD =====

    async extractRustItems() {
        try {
            console.log('=== Rust Item Extractor ===');
            console.log('Checking setup...');
            
            // Ensure required directories exist
            this.createDirectories();
            
            // Start AssetRipper
            await this.startAssetRipper();
            
            // Wait for it to be ready
            await this.waitForAssetRipper();
            
            // Check for bundle file
            const bundlePath = this.checkBundleFile();
            await this.loadBundle(bundlePath);
            
            // Extract all items
            const { items, blueprints } = await this.extractAllItems();
            
            if (items.length === 0) {
                console.log('No items found. Please check your bundle file.');
                return;
            }
            
            // Match items with blueprints
            const itemsWithBlueprints = this.matchItemsWithBlueprints(items, blueprints);
            
            // Save to file
            this.saveToFile(itemsWithBlueprints);
            
            // Display summary
            console.log('\n=== EXTRACTION SUMMARY ===');
            console.log(`Total items: ${itemsWithBlueprints.length}`);
            console.log(`Items with crafting recipes: ${itemsWithBlueprints.filter(item => item.ingredients.length > 0).length}`);
            console.log(`Items without crafting recipes: ${itemsWithBlueprints.filter(item => item.ingredients.length === 0).length}`);
            
            // Show some examples
            console.log('\n=== SAMPLE ITEMS ===');
            itemsWithBlueprints.slice(0, 10).forEach(item => {
                console.log(`${item.shortname}: ${item.displayName}`);
                if (item.ingredients.length > 0) {
                    console.log(`  Ingredients: ${item.ingredients.map(ing => `${ing.amount}x ${ing.itemDef?.m_PathID || 'Unknown'}`).join(', ')}`);
                    console.log(`  Craft time: ${item.craftTime}s, Amount: ${item.amountToCreate}`);
                } else {
                    console.log(`  No crafting recipe`);
                }
            });
            
            // Show file locations
            const processedDataDir = path.resolve('processed-data');
            console.log('\n=== FILES SAVED ===');
            console.log(`📁 Items data: ${path.join(processedDataDir, 'rust_items.json')}`);
            console.log(`📁 Summary: ${path.join(processedDataDir, 'extraction_summary.json')}`);
            console.log('\n✅ Extraction completed successfully!');
            
        } catch (error) {
            console.error('Error:', error.message);
            throw error;
        } finally {
            await this.cleanup();
        }
    }
}

module.exports = AssetRipperManager;
