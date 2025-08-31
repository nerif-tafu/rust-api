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
                
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`SteamCMD download failed with code ${code}`));
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

    findRustBundleFile() {
        const gameDataDir = path.resolve(this.directories.gameData);
        const possiblePaths = [
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
        const targetPath = path.join(process.cwd(), 'game-data', 'items.preload.bundle');
        
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
