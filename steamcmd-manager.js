const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');
require('dotenv').config();

const pipelineAsync = promisify(pipeline);

class SteamCMDManager {
    constructor() {
        this.steamAppId = process.env.STEAM_APP_ID || '252490'; // Rust
        this.steamUsername = process.env.STEAM_USERNAME;
        this.steamPassword = process.env.STEAM_PASSWORD;
        
        this.directories = {
            steamCmd: 'steam-cmd',
            gameData: 'game-data'
        };
        
        // SteamCMD download URLs for different platforms
        this.steamCmdUrls = {
            'darwin': 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
            'linux': 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
            'win32': 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
        };
        
        this.os = process.platform;
    }

    validateCredentials() {
        if (!this.steamUsername || !this.steamPassword) {
            console.error('❌ Missing required Steam credentials!');
            console.error('');
            console.error('Please create a .env file with the following content:');
            console.error('STEAM_USERNAME=your_username');
            console.error('STEAM_PASSWORD=your_password');
            console.error('STEAM_APP_ID=252490');
            console.error('');
            console.error('The .env file should be in the root directory of this project.');
            console.error('Make sure to replace "your_username" and "your_password" with your actual Steam credentials.');
            process.exit(1);
        }
        
        console.log('✅ Steam credentials found and validated');
        console.log(`Username: ${this.steamUsername}`);
        console.log(`App ID: ${this.steamAppId}`);
        console.log('');
    }

    // ===== SETUP METHODS =====

    createDirectories() {
        console.log('Creating directory structure...');
        
        for (const [name, dir] of Object.entries(this.directories)) {
            const fullPath = path.resolve(dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`Created directory: ${fullPath}`);
            } else {
                console.log(`Directory already exists: ${fullPath}`);
            }
        }
    }

    getSteamCmdUrl() {
        const url = this.steamCmdUrls[this.os];
        
        if (!url) {
            throw new Error(`Unsupported operating system: ${this.os}`);
        }
        
        return url;
    }

    async downloadFile(url, destination) {
        console.log(`Downloading SteamCMD from: ${url}`);
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

    async extractSteamCmd(archivePath, extractPath) {
        console.log(`Extracting SteamCMD to: ${extractPath}`);
        
        try {
            if (this.os === 'darwin' || this.os === 'linux') {
                // Extract tar.gz on Unix-like systems
                execSync(`tar -xzf "${archivePath}" -C "${extractPath}"`, { stdio: 'inherit' });
            } else if (this.os === 'win32') {
                // Extract zip on Windows
                execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractPath}' -Force"`, { stdio: 'inherit' });
            }
            
            console.log('Extraction completed successfully!');
        } catch (error) {
            throw new Error(`Failed to extract SteamCMD: ${error.message}`);
        }
    }

    async setupSteamCmd() {
        const steamCmdDir = path.resolve(this.directories.steamCmd);
        const downloadUrl = this.getSteamCmdUrl();
        
        // Determine archive filename based on OS
        let archiveFilename;
        if (this.os === 'darwin') {
            archiveFilename = 'steamcmd_osx.tar.gz';
        } else if (this.os === 'linux') {
            archiveFilename = 'steamcmd_linux.tar.gz';
        } else if (this.os === 'win32') {
            archiveFilename = 'steamcmd.zip';
        }
        
        const archivePath = path.join(steamCmdDir, archiveFilename);
        const steamCmdPath = this.getSteamCmdPath();
        
        // Check if SteamCMD is already installed
        if (fs.existsSync(steamCmdPath)) {
            console.log(`SteamCMD already exists at: ${steamCmdPath}`);
            return steamCmdPath;
        }
        
        // Download SteamCMD
        await this.downloadFile(downloadUrl, archivePath);
        
        // Extract SteamCMD
        await this.extractSteamCmd(archivePath, steamCmdDir);
        
        // Clean up the archive file
        fs.unlinkSync(archivePath);
        console.log('Cleaned up downloaded archive file');
        
        // Make executable on Unix-like systems
        if (this.os !== 'win32') {
            try {
                fs.chmodSync(steamCmdPath, '755');
                console.log('Made SteamCMD executable');
            } catch (error) {
                console.warn(`Warning: Could not make SteamCMD executable: ${error.message}`);
            }
        }
        
        console.log(`SteamCMD setup completed: ${steamCmdPath}`);
        return steamCmdPath;
    }

    getSteamCmdPath() {
        const steamCmdDir = path.resolve(this.directories.steamCmd);
        
        if (this.os === 'win32') {
            return path.join(steamCmdDir, 'steamcmd.exe');
        } else {
            return path.join(steamCmdDir, 'steamcmd.sh');
        }
    }

    // ===== STEAM DOWNLOAD METHODS =====

    async downloadRustGame() {
        console.log('Starting Rust game download...');
        
        // Update status to indicate game downloading
        if (global.serverStatus && global.serverStatus.updateStatus) {
            global.serverStatus.updateStatus(3, 'Downloading Rust game files - this may take a while', {
                stage: 'download',
                progress: 0
            });
        }
        
        if (!this.steamUsername || !this.steamPassword) {
            throw new Error('Steam credentials not found in .env file. Please set STEAM_USERNAME and STEAM_PASSWORD.');
        }
        
        const steamCmdPath = this.getSteamCmdPath();
        const gameDataDir = path.resolve(this.directories.gameData);
        
        if (!fs.existsSync(steamCmdPath)) {
            throw new Error(`SteamCMD not found at ${steamCmdPath}. Please run setup first.`);
        }
        
        // Create Steam script for downloading
        const scriptContent = this.createSteamScript();
        const scriptPath = path.join(path.dirname(steamCmdPath), 'download_rust.txt');
        
        fs.writeFileSync(scriptPath, scriptContent);
        
        console.log('Created Steam download script');
        console.log(`Downloading Rust (App ID: ${this.steamAppId}) to: ${gameDataDir}`);
        
        return new Promise((resolve, reject) => {
            const args = ['+runscript', scriptPath];
            
            const steamProcess = spawn(steamCmdPath, args, {
                cwd: path.dirname(steamCmdPath),
                stdio: 'pipe'
            });
            
            steamProcess.stdout.on('data', (data) => {
                const output = data.toString();
                console.log(output.trim());
                
                // Check for completion
                if (output.includes('Success! App \'' + this.steamAppId + '\' fully installed.')) {
                    console.log('✅ Rust download completed successfully!');
                }
            });
            
            steamProcess.stderr.on('data', (data) => {
                const output = data.toString();
                console.log(`SteamCMD stderr: ${output.trim()}`);
            });
            
            steamProcess.on('close', (code) => {
                console.log(`SteamCMD process exited with code ${code}`);
                
                // Clean up script file
                try {
                    fs.unlinkSync(scriptPath);
                    console.log('Cleaned up download script');
                } catch (error) {
                    console.warn('Could not clean up script file:', error.message);
                }
                
                // Check if the download was actually successful despite exit code
                const gameDataDir = path.resolve(this.directories.gameData);
                const rustExePath = path.join(gameDataDir, 'Rust', 'rust.exe');
                const rustAppPath = path.join(gameDataDir, 'Rust', 'rust.app');
                const rustLinuxPath = path.join(gameDataDir, 'Rust', 'rust');
                
                const hasRustFiles = fs.existsSync(rustExePath) || fs.existsSync(rustAppPath) || fs.existsSync(rustLinuxPath);
                
                if (hasRustFiles) {
                    console.log('✅ Rust files found despite SteamCMD exit code - download was successful');
                    
                    // Update status to indicate download completed
                    if (global.serverStatus && global.serverStatus.updateStatus) {
                        global.serverStatus.updateStatus(4, 'Rust download completed - setting up AssetRipper', {
                            stage: 'download_complete',
                            rustFilesFound: true
                        });
                    }
                    
                    // Get the current build ID and save it after successful download
                    this.getCurrentBuildId().then(buildId => {
                        if (buildId) {
                            this.saveGameVersion(buildId);
                        }
                    }).catch(error => {
                        console.warn('Could not get build ID after download:', error.message);
                    });
                    resolve();
                } else if (code === 0) {
                    // Exit code 0 is always success
                    
                    // Update status to indicate download completed
                    if (global.serverStatus && global.serverStatus.updateStatus) {
                        global.serverStatus.updateStatus(4, 'Rust download completed - setting up AssetRipper', {
                            stage: 'download_complete',
                            exitCode: code
                        });
                    }
                    
                    this.getCurrentBuildId().then(buildId => {
                        if (buildId) {
                            this.saveGameVersion(buildId);
                        }
                    }).catch(error => {
                        console.warn('Could not get build ID after download:', error.message);
                    });
                    resolve();
                } else {
                    console.warn(`SteamCMD exited with code ${code}, but this might be normal after successful download`);
                    // Try to get build ID anyway, as the download might have succeeded
                    this.getCurrentBuildId().then(buildId => {
                        if (buildId) {
                            this.saveGameVersion(buildId);
                            console.log('✅ Successfully got build ID despite exit code - treating as success');
                            resolve();
                        } else {
                            reject(new Error(`SteamCMD download failed with code ${code} and no Rust files found`));
                        }
                    }).catch(error => {
                        reject(new Error(`SteamCMD download failed with code ${code} and could not verify success: ${error.message}`));
                    });
                }
            });
            
            steamProcess.on('error', (error) => {
                reject(new Error(`Failed to start SteamCMD: ${error.message}`));
            });
        });
    }

    createSteamScript() {
        const gameDataDir = path.resolve(this.directories.gameData);
        
        return `@ShutdownOnFailedCommand 1
@NoPromptForPassword 1
force_install_dir "${gameDataDir}"
login ${this.steamUsername} ${this.steamPassword}
app_update ${this.steamAppId} validate
quit`;
    }

    // ===== BUNDLE FILE LOCATION =====

    async checkGameVersion() {
        console.log('Checking if Rust game version has changed...');
        
        const steamCmdPath = this.getSteamCmdPath();
        if (!fs.existsSync(steamCmdPath)) {
            console.log('SteamCMD not found. Cannot check version without SteamCMD.');
            return false;
        }
        
        try {
            // Create a script to get app info
            const scriptContent = `@ShutdownOnFailedCommand 1
@NoPromptForPassword 1
app_info_print ${this.steamAppId}
quit`;
            
            const scriptPath = path.join(path.dirname(steamCmdPath), 'check_version.txt');
            fs.writeFileSync(scriptPath, scriptContent);
            
            return new Promise((resolve, reject) => {
                const args = ['+runscript', scriptPath];
                
                const steamProcess = spawn(steamCmdPath, args, {
                    cwd: path.dirname(steamCmdPath),
                    stdio: 'pipe'
                });
                
                let output = '';
                
                steamProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });
                
                steamProcess.stderr.on('data', (data) => {
                    // Ignore stderr for version checking
                });
                
                steamProcess.on('close', (code) => {
                    // Clean up script file
                    try {
                        fs.unlinkSync(scriptPath);
                    } catch (error) {
                        console.warn('Could not clean up version check script:', error.message);
                    }
                    
                    if (code === 0) {
                        // Parse the build ID from the output
                        const buildIdMatch = output.match(/"public"\s*{\s*"buildid"\s*"(\d+)"/);
                        if (buildIdMatch) {
                            const currentBuildId = buildIdMatch[1];
                            const versionFilePath = path.join(process.cwd(), 'game-data', 'version.txt');
                            
                            // Check if we have a stored version
                            if (fs.existsSync(versionFilePath)) {
                                const storedBuildId = fs.readFileSync(versionFilePath, 'utf8').trim();
                                
                                if (storedBuildId === currentBuildId) {
                                    console.log(`✅ Rust version unchanged (Build ID: ${currentBuildId})`);
                                    resolve(false); // No update needed
                                } else {
                                    console.log(`🔄 Rust version changed: ${storedBuildId} → ${currentBuildId}`);
                                    // Save the new version
                                    this.saveGameVersion(currentBuildId);
                                    resolve(true); // Update needed
                                }
                            } else {
                                console.log(`📝 No stored version found. Current Build ID: ${currentBuildId}`);
                                // Save the current version for future reference
                                this.saveGameVersion(currentBuildId);
                                resolve(true); // Update needed (first time)
                            }
                        } else {
                            console.log('⚠️  Could not parse build ID from Steam output');
                            resolve(true); // Assume update needed if we can't parse
                        }
                    } else {
                        console.log(`⚠️  SteamCMD version check failed with code ${code}`);
                        resolve(true); // Assume update needed if check fails
                    }
                });
                
                steamProcess.on('error', (error) => {
                    console.log(`⚠️  Failed to start SteamCMD for version check: ${error.message}`);
                    resolve(true); // Assume update needed if we can't start SteamCMD
                });
            });
            
        } catch (error) {
            console.log(`⚠️  Version check failed: ${error.message}`);
            return true; // Assume update needed if check fails
        }
    }

    async getCurrentBuildId() {
        const steamCmdPath = this.getSteamCmdPath();
        if (!fs.existsSync(steamCmdPath)) {
            return null;
        }
        
        try {
            const scriptContent = `@ShutdownOnFailedCommand 1
@NoPromptForPassword 1
app_info_print ${this.steamAppId}
quit`;
            
            const scriptPath = path.join(path.dirname(steamCmdPath), 'get_build_id.txt');
            fs.writeFileSync(scriptPath, scriptContent);
            
            return new Promise((resolve, reject) => {
                const args = ['+runscript', scriptPath];
                
                const steamProcess = spawn(steamCmdPath, args, {
                    cwd: path.dirname(steamCmdPath),
                    stdio: 'pipe'
                });
                
                let output = '';
                
                steamProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });
                
                steamProcess.on('close', (code) => {
                    // Clean up script file
                    try {
                        fs.unlinkSync(scriptPath);
                    } catch (error) {
                        console.warn('Could not clean up build ID script:', error.message);
                    }
                    
                    if (code === 0) {
                        // Parse the build ID from the output
                        const buildIdMatch = output.match(/"public"\s*{\s*"buildid"\s*"(\d+)"/);
                        if (buildIdMatch) {
                            resolve(buildIdMatch[1]);
                        } else {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });
                
                steamProcess.on('error', (error) => {
                    resolve(null);
                });
            });
        } catch (error) {
            return null;
        }
    }

    saveGameVersion(buildId) {
        const versionFilePath = path.join(process.cwd(), 'game-data', 'version.txt');
        try {
            fs.writeFileSync(versionFilePath, buildId);
            console.log(`💾 Saved game version: ${buildId}`);
        } catch (error) {
            console.warn(`Warning: Could not save game version: ${error.message}`);
        }
    }

    findRustBundleFile() {
        const gameDataDir = path.resolve(this.directories.gameData);
        const possiblePaths = [
            // New location after SteamCMD download
            path.join(gameDataDir, 'Bundles', 'shared', 'items.preload.bundle'),
            // Legacy locations (keeping for backward compatibility)
            path.join(gameDataDir, 'Rust.app', 'Contents', 'Data', 'StreamingAssets', 'bundles', 'items.preload.bundle'),
            path.join(gameDataDir, 'Rust', 'Rust_Data', 'StreamingAssets', 'bundles', 'items.preload.bundle'),
            path.join(gameDataDir, 'steamapps', 'common', 'Rust', 'Rust_Data', 'StreamingAssets', 'bundles', 'items.preload.bundle')
        ];
        
        for (const bundlePath of possiblePaths) {
            if (fs.existsSync(bundlePath)) {
                console.log(`Found Rust bundle file: ${bundlePath}`);
                return bundlePath;
            }
        }
        
        console.log('Rust bundle file not found in expected locations:');
        possiblePaths.forEach(path => console.log(`  - ${path}`));
        return null;
    }

    copyBundleToGameData(bundlePath) {
        const targetPath = path.join(process.cwd(), 'game-data', 'Bundles', 'shared', 'items.preload.bundle');
        
        // Ensure the target directory exists
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        try {
            fs.copyFileSync(bundlePath, targetPath);
            console.log(`Copied bundle file to: ${targetPath}`);
            return true;
        } catch (error) {
            console.error(`Failed to copy bundle file: ${error.message}`);
            return false;
        }
    }

    // ===== MAIN METHODS =====

    async setup() {
        try {
            console.log('=== SteamCMD Setup ===');
            console.log(`Operating System: ${this.os}`);
            console.log(`Steam App ID: ${this.steamAppId}`);
            
            // Create directories
            this.createDirectories();
            
            // Setup SteamCMD
            await this.setupSteamCmd();
            
            console.log('\n=== Setup Complete ===');
            console.log('SteamCMD is ready to use!');
            
        } catch (error) {
            console.error('Setup failed:', error.message);
            throw error;
        }
    }

    async downloadRust() {
        try {
            console.log('=== Rust Game Download ===');
            
            // Ensure SteamCMD is set up
            const steamCmdPath = this.getSteamCmdPath();
            if (!fs.existsSync(steamCmdPath)) {
                console.log('SteamCMD not found. Setting up first...');
                await this.setup();
            }
            
            // Download Rust
            await this.downloadRustGame();
            
            // Find and copy bundle file
            const bundlePath = this.findRustBundleFile();
            if (bundlePath) {
                this.copyBundleToGameData(bundlePath);
            } else {
                console.log('⚠️  Rust bundle file not found. You may need to manually locate it.');
            }
            
            console.log('\n=== Download Complete ===');
            console.log('Rust has been downloaded successfully!');
            
        } catch (error) {
            console.error('Download failed:', error.message);
            throw error;
        }
    }

    async ensureRustFilesAvailable() {
        // Validate credentials first
        this.validateCredentials();
        
        const bundlePath = './game-data/Bundles/shared/items.preload.bundle';
        
        if (!fs.existsSync(bundlePath)) {
            console.log('📦 Rust bundle file not found. Downloading Rust game files first...');
            console.log('');
            
            await this.downloadRust();
            
            // Verify the bundle file now exists
            if (!fs.existsSync(bundlePath)) {
                throw new Error('Failed to download Rust game files or locate items.preload.bundle');
            }
            
            console.log('✅ Rust game files downloaded successfully!');
            console.log('');
        } else {
            console.log('✅ Rust bundle file already exists');
            console.log('');
        }
        
        return bundlePath;
    }

    async startContinuousMonitoring(checkIntervalMinutes = 1) {
        console.log(`🚀 Starting continuous monitoring for Rust updates (checking every ${checkIntervalMinutes} minute${checkIntervalMinutes !== 1 ? 's' : ''})`);
        console.log('Press Ctrl+C to stop monitoring');
        console.log('');
        
        // Initial check
        await this.performUpdateIfNeeded();
        
        // Set up continuous monitoring
        const intervalMs = checkIntervalMinutes * 60 * 1000;
        
        setInterval(async () => {
            try {
                await this.performUpdateIfNeeded();
            } catch (error) {
                console.error(`❌ Error during update check: ${error.message}`);
            }
        }, intervalMs);
        
        // Keep the process running
        process.on('SIGINT', () => {
            console.log('\n🛑 Monitoring stopped by user');
            process.exit(0);
        });
        
        // Keep alive
        setInterval(() => {
            // This keeps the process running
        }, 1000);
    }

    async performUpdateIfNeeded() {
        try {
            const needsUpdate = await this.checkGameVersion();
            
            if (needsUpdate) {
                console.log('🔄 Update needed! Starting download and extraction process...');
                console.log('');
                
                // Download Rust
                await this.downloadRust();
                
                // Find and copy bundle file
                const bundlePath = this.findRustBundleFile();
                if (bundlePath) {
                    this.copyBundleToGameData(bundlePath);
                } else {
                    console.log('⚠️  Rust bundle file not found after update. You may need to manually locate it.');
                }
                
                console.log('✅ Update completed successfully!');
                console.log('');
                
                // Run AssetRipper extraction
                console.log('🔄 Running AssetRipper extraction with updated files...');
                const AssetRipperManager = require('./asset-ripper-manager');
                const manager = new AssetRipperManager();
                await manager.extractRustItems();
                
            } else {
                console.log('✅ No update needed at this time');
            }
            
        } catch (error) {
            console.error(`❌ Error during update check: ${error.message}`);
        }
    }

    async run() {
        try {
            console.log('=== SteamCMD Manager ===');
            
            // Check if .env file exists
            if (!fs.existsSync('.env')) {
                console.error('❌ .env file not found!');
                console.error('Please create a .env file with your Steam credentials:');
                console.error('STEAM_USERNAME=your_username');
                console.error('STEAM_PASSWORD=your_password');
                console.error('STEAM_APP_ID=252490');
                process.exit(1);
            }
            
            // Setup SteamCMD
            await this.setup();
            
            // Download Rust
            await this.downloadRust();
            
            console.log('\n✅ All operations completed successfully!');
            
        } catch (error) {
            console.error('Operation failed:', error.message);
            process.exit(1);
        }
    }
}

// Run if this file is executed directly
if (require.main === module) {
    const manager = new SteamCMDManager();
    manager.run();
}

module.exports = SteamCMDManager;
