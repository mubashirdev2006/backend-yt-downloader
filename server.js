const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const app = express();

app.use(cors());
app.use(express.json());

// Track downloads
const downloadStats = {
    total: 0,
    successful: 0,
    failed: 0,
    history: []
};

// Upload to Buzzheavier
async function uploadToBuzzheavier(filePath, filename, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📤 Uploading to Buzzheavier (Attempt ${attempt}/${retries})...`);
            
            const formData = new FormData();
            formData.append('file', fs.createReadStream(filePath), filename);
            
            const response = await axios.post('https://buzzheavier.com/api/upload', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Accept': 'application/json'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 600000, // 10 minutes
                onUploadProgress: (progressEvent) => {
                    const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                    if (percent % 20 === 0) {
                        console.log(`   Upload progress: ${percent}%`);
                    }
                }
            });
            
            if (response.data && (response.data.url || response.data.id)) {
                console.log('✅ Uploaded to Buzzheavier successfully!');
                
                return {
                    success: true,
                    downloadUrl: response.data.url,
                    directLink: response.data.direct_url || response.data.url,
                    fileId: response.data.id || response.data.file_id,
                    service: 'buzzheavier.com',
                    expiry: 'Never expires',
                    note: 'Unlimited downloads! File stays forever.'
                };
            }
            
            console.log('⚠️ Unexpected response:', response.data);
            
        } catch (error) {
            console.error(`❌ Attempt ${attempt} failed:`, error.message);
            
            if (attempt === retries) {
                return { 
                    success: false, 
                    error: `Upload failed after ${retries} attempts: ${error.message}` 
                };
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

// Get video info
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`\n🔍 Fetching info: ${url}`);
    
    exec(`yt-dlp -J "${url}"`, { 
        maxBuffer: 1024 * 1024 * 10,
        timeout: 30000 
    }, (error, stdout, stderr) => {
        if (error) {
            console.error('yt-dlp error:', error.message);
            return res.status(500).json({ 
                error: 'Failed to fetch video info',
                details: 'Make sure the URL is correct and the video is public'
            });
        }

        try {
            const info = JSON.parse(stdout);
            
            const formats = [];
            const seenQualities = new Set();
            
            // Available video formats
            if (info.formats) {
                info.formats.forEach(format => {
                    if (format.vcodec !== 'none' && format.acodec !== 'none' && format.height) {
                        const quality = `${format.height}p`;
                        if (!seenQualities.has(quality)) {
                            seenQualities.add(quality);
                            
                            let sizeLabel = '';
                            if (format.filesize) {
                                const sizeMB = (format.filesize / (1024 * 1024)).toFixed(1);
                                sizeLabel = ` (~${sizeMB}MB)`;
                            } else if (format.filesize_approx) {
                                const sizeMB = (format.filesize_approx / (1024 * 1024)).toFixed(1);
                                sizeLabel = ` (~${sizeMB}MB est.)`;
                            }
                            
                            formats.push({
                                id: format.format_id,
                                quality: quality,
                                type: 'video',
                                ext: format.ext,
                                filesize: format.filesize || format.filesize_approx || 0,
                                label: `${quality} ${format.ext.toUpperCase()}${sizeLabel}`
                            });
                        }
                    }
                });
            }
            
            // Audio formats
            formats.push(
                { 
                    id: 'bestaudio', 
                    quality: '320kbps', 
                    type: 'audio', 
                    ext: 'mp3', 
                    label: '🎵 MP3 320kbps (Best Quality)' 
                },
                { 
                    id: 'bestaudio', 
                    quality: '192kbps', 
                    type: 'audio', 
                    ext: 'mp3', 
                    label: '🎵 MP3 192kbps (Good Quality)' 
                },
                { 
                    id: 'bestaudio', 
                    quality: '128kbps', 
                    type: 'audio', 
                    ext: 'mp3', 
                    label: '🎵 MP3 128kbps (Small Size)' 
                },
                { 
                    id: 'bestaudio', 
                    quality: 'lossless', 
                    type: 'audio', 
                    ext: 'wav', 
                    label: '🎵 WAV Lossless (Studio Quality)' 
                }
            );
            
            // Sort video formats by quality (highest first)
            const videoFormats = formats
                .filter(f => f.type === 'video')
                .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
            
            const audioFormats = formats.filter(f => f.type === 'audio');
            
            res.json({
                success: true,
                title: info.title,
                thumbnail: info.thumbnail,
                duration: info.duration,
                uploader: info.uploader,
                viewCount: info.view_count,
                videoFormats: videoFormats,
                audioFormats: audioFormats,
                videoId: info.id
            });
            
            console.log(`✅ Found: "${info.title}" - ${videoFormats.length} video + ${audioFormats.length} audio formats`);
            
        } catch (e) {
            console.error('Parse error:', e);
            res.status(500).json({ error: 'Failed to parse video info' });
        }
    });
});

// Download + Upload
app.post('/api/download', async (req, res) => {
    const { url, formatId, type, quality } = req.body;
    
    if (!url || !formatId) {
        return res.status(400).json({ error: 'URL and format ID are required' });
    }

    downloadStats.total++;
    const timestamp = Date.now();
    const downloadDir = '/tmp/youtube-downloads';
    
    // Ensure download directory exists
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    // Clean up old files (>30 minutes)
    try {
        const files = fs.readdirSync(downloadDir);
        files.forEach(file => {
            const filePath = path.join(downloadDir, file);
            const stats = fs.statSync(filePath);
            if (Date.now() - stats.mtimeMs > 30 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Cleaned old file: ${file}`);
            }
        });
    } catch (e) {}
    
    const outputTemplate = path.join(downloadDir, `${timestamp}_%(title)s.%(ext)s`);
    let command;
    
    // Build yt-dlp command based on type
    if (type === 'audio') {
        switch(quality) {
            case 'lossless':
                command = `yt-dlp -f bestaudio --extract-audio --audio-format wav -o "${outputTemplate}" "${url}"`;
                break;
            case '192kbps':
                command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 192K -o "${outputTemplate}" "${url}"`;
                break;
            case '128kbps':
                command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 128K -o "${outputTemplate}" "${url}"`;
                break;
            default: // 320kbps
                command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 320K -o "${outputTemplate}" "${url}"`;
        }
    } else {
        // Video: download best video + best audio, merge
        command = `yt-dlp -f "${formatId}+bestaudio/best" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
    }
    
    console.log(`\n🎬 Command: ${command}`);
    
    try {
        // Step 1: Download with yt-dlp
        console.log('📥 Downloading video...');
        await new Promise((resolve, reject) => {
            const child = exec(command, { 
                maxBuffer: 1024 * 1024 * 100,
                timeout: 600000 // 10 minutes
            }, (error, stdout, stderr) => {
                if (error) {
                    console.error('Download error:', stderr);
                    reject(new Error('Download failed. Video might be private or age-restricted.'));
                } else {
                    resolve(stdout);
                }
            });
            
            // Log download progress
            child.stderr.on('data', (data) => {
                if (data.includes('[download]')) {
                    const match = data.toString().match(/(\d+\.?\d*)%/);
                    if (match) {
                        console.log(`   Download: ${match[1]}%`);
                    }
                }
            });
        });
        
        // Step 2: Find downloaded file
        const files = fs.readdirSync(downloadDir);
        const downloadedFile = files.find(f => f.startsWith(`${timestamp}_`));
        
        if (!downloadedFile) {
            throw new Error('Downloaded file not found');
        }
        
        const filePath = path.join(downloadDir, downloadedFile);
        const fileSize = fs.statSync(filePath).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        
        console.log(`✅ Downloaded: ${downloadedFile} (${sizeMB} MB)`);
        
        // Step 3: Upload to Buzzheavier
        const uploadResult = await uploadToBuzzheavier(filePath, downloadedFile);
        
        // Step 4: Delete local file immediately
        fs.unlink(filePath, (err) => {
            if (err) console.error('Failed to delete local file:', err);
            else console.log('🗑️ Local file deleted');
        });
        
        if (!uploadResult.success) {
            throw new Error(uploadResult.error || 'Upload to Buzzheavier failed');
        }
        
        // Step 5: Track stats
        downloadStats.successful++;
        downloadStats.history.unshift({
            filename: downloadedFile,
            size: sizeMB,
            timestamp: new Date().toISOString(),
            service: 'buzzheavier.com'
        });
        
        // Keep only last 100 in history
        if (downloadStats.history.length > 100) {
            downloadStats.history = downloadStats.history.slice(0, 100);
        }
        
        // Send success response
        console.log('🎉 All done! Sending download link...\n');
        
        res.json({
            success: true,
            downloadUrl: uploadResult.downloadUrl,
            directLink: uploadResult.directLink,
            filename: downloadedFile,
            fileSize: sizeMB,
            fileId: uploadResult.fileId,
            service: 'Buzzheavier',
            note: '✅ Unlimited downloads! File never expires! 🔥'
        });
        
    } catch (error) {
        downloadStats.failed++;
        console.error('❌ Process failed:', error.message);
        
        // Clean up on error
        try {
            const files = fs.readdirSync(downloadDir);
            const tempFile = files.find(f => f.startsWith(`${timestamp}_`));
            if (tempFile) {
                fs.unlinkSync(path.join(downloadDir, tempFile));
            }
        } catch (e) {}
        
        res.status(500).json({ 
            error: 'Download failed',
            details: error.message
        });
    }
});

// Add this temporary debug endpoint
app.get('/api/debug', (req, res) => {
    exec('yt-dlp --version', (error, stdout, stderr) => {
        if (error) {
            return res.json({ 
                ytdlp: 'NOT INSTALLED', 
                error: error.message,
                stderr: stderr 
            });
        }
        
        exec('python3 --version', (pyError, pyStdout) => {
            res.json({
                ytdlp: stdout.trim(),
                python: pyStdout ? pyStdout.trim() : 'Unknown',
                ffmpeg: 'checking...'
            });
        });
    });
});

// Get download stats
app.get('/api/stats', (req, res) => {
    res.json({
        ...downloadStats,
        successRate: downloadStats.total > 0 
            ? `${((downloadStats.successful / downloadStats.total) * 100).toFixed(1)}%` 
            : '0%',
        storage: 'Buzzheavier - Unlimited Downloads, Never Expires',
        features: [
            '🔥 Unlimited downloads',
            '♾️ Files never expire',
            '⚡ Fast download speeds',
            '🆓 Completely free'
        ]
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        message: 'YouTube Downloader API is running',
        storage: 'Buzzheavier (Unlimited)',
        uptime: process.uptime()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'YouTube Downloader API',
        version: '2.0.0',
        description: 'Download YouTube videos & audio - Unlimited downloads via Buzzheavier',
        endpoints: {
            fetchInfo: 'POST /api/info',
            download: 'POST /api/download',
            stats: 'GET /api/stats',
            health: 'GET /health'
        },
        features: [
            'All video qualities (144p to 4K)',
            'Audio extraction (MP3/WAV)',
            'Unlimited downloads',
            'Files never expire',
            'No registration required'
        ]
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║                                              ║
║   🎥 YouTube Downloader API v2.0            ║
║   🚀 Running on port ${PORT}                  ║
║   ☁️  Storage: Buzzheavier (Unlimited)       ║
║   ♾️  Files: Never Expire                    ║
║   ⬇️  Downloads: Unlimited                   ║
║                                              ║
╚══════════════════════════════════════════════╝
    `);
});