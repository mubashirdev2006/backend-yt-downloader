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

// Try different yt-dlp paths
const YTDLP_COMMANDS = [
    'yt-dlp',
    'python3 -m yt_dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '~/.local/bin/yt-dlp'
];

let workingYtDlp = null;

// Find working yt-dlp on startup
function findYtDlp() {
    return new Promise((resolve) => {
        const tryCommand = (index) => {
            if (index >= YTDLP_COMMANDS.length) {
                console.error('❌ Could not find yt-dlp');
                resolve(null);
                return;
            }
            
            const cmd = `${YTDLP_COMMANDS[index]} --version`;
            console.log(`Checking: ${cmd}`);
            
            exec(cmd, { timeout: 5000 }, (error, stdout) => {
                if (!error && stdout) {
                    console.log(`✅ Found yt-dlp: ${YTDLP_COMMANDS[index]} - ${stdout.trim()}`);
                    resolve(YTDLP_COMMANDS[index]);
                } else {
                    tryCommand(index + 1);
                }
            });
        };
        
        tryCommand(0);
    });
}

// Run yt-dlp command
function runYtDlp(args, callback) {
    if (!workingYtDlp) {
        return callback(new Error('yt-dlp not available'));
    }
    
    const command = `${workingYtDlp} ${args}`;
    console.log('Running:', command);
    exec(command, { maxBuffer: 1024 * 1024 * 50, timeout: 600000 }, callback);
}

// Upload to Buzzheavier
async function uploadToBuzzheavier(filePath, filename) {
    try {
        console.log('📤 Uploading to Buzzheavier...');
        
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), filename);
        
        const response = await axios.post('https://buzzheavier.com/api/upload', formData, {
            headers: {
                ...formData.getHeaders(),
                'Accept': 'application/json'
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 600000
        });
        
        if (response.data && response.data.url) {
            console.log('✅ Uploaded to Buzzheavier');
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
        
        throw new Error('Upload failed: ' + JSON.stringify(response.data));
    } catch (error) {
        console.error('Buzzheavier upload failed:', error.message);
        return { success: false, error: error.message };
    }
}

// Get video info
app.post('/api/info', (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`\n🔍 Fetching info: ${url}`);
    
    runYtDlp(`-J --no-check-certificate "${url}"`, (error, stdout, stderr) => {
        if (error) {
            console.error('yt-dlp error:', error.message);
            console.error('Stderr:', stderr);
            return res.status(500).json({ 
                error: 'Failed to fetch video info',
                details: stderr || error.message
            });
        }

        try {
            const info = JSON.parse(stdout);
            
            const formats = [];
            const seenQualities = new Set();
            
            if (info.formats) {
                info.formats.forEach(format => {
                    if (format.vcodec !== 'none' && format.acodec !== 'none' && format.height) {
                        const quality = `${format.height}p`;
                        if (!seenQualities.has(quality)) {
                            seenQualities.add(quality);
                            
                            let sizeLabel = '';
                            if (format.filesize) {
                                const sizeMB = (format.filesize / (1024 * 1024)).toFixed(0);
                                sizeLabel = ` (~${sizeMB}MB)`;
                            }
                            
                            formats.push({
                                id: format.format_id,
                                quality: quality,
                                type: 'video',
                                ext: format.ext,
                                filesize: format.filesize || 0,
                                label: `${quality} (${format.ext})${sizeLabel}`
                            });
                        }
                    }
                });
            }
            
            const audioFormats = [
                { id: 'bestaudio', quality: '320kbps', type: 'audio', ext: 'mp3', label: '🎵 MP3 320kbps' },
                { id: 'bestaudio', quality: '192kbps', type: 'audio', ext: 'mp3', label: '🎵 MP3 192kbps' },
                { id: 'bestaudio', quality: '128kbps', type: 'audio', ext: 'mp3', label: '🎵 MP3 128kbps' },
                { id: 'bestaudio', quality: 'lossless', type: 'audio', ext: 'wav', label: '🎵 WAV Lossless' }
            ];
            
            const videoFormats = formats
                .filter(f => f.type === 'video')
                .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
            
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
            
        } catch (e) {
            console.error('Parse error:', e);
            res.status(500).json({ error: 'Failed to parse video info' });
        }
    });
});
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
// Download endpoint
app.post('/api/download', (req, res) => {
    const { url, formatId, type, quality } = req.body;
    
    if (!url || !formatId) {
        return res.status(400).json({ error: 'URL and format ID are required' });
    }

    const timestamp = Date.now();
    const downloadDir = '/tmp/youtube-downloads';
    
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    const outputTemplate = path.join(downloadDir, `${timestamp}_%(title)s.%(ext)s`);
    let args;
    
    if (type === 'audio') {
        switch(quality) {
            case 'lossless':
                args = `-f bestaudio --extract-audio --audio-format wav -o "${outputTemplate}" "${url}"`;
                break;
            case '192kbps':
                args = `-f bestaudio --extract-audio --audio-format mp3 --audio-quality 192K -o "${outputTemplate}" "${url}"`;
                break;
            case '128kbps':
                args = `-f bestaudio --extract-audio --audio-format mp3 --audio-quality 128K -o "${outputTemplate}" "${url}"`;
                break;
            default:
                args = `-f bestaudio --extract-audio --audio-format mp3 --audio-quality 320K -o "${outputTemplate}" "${url}"`;
        }
    } else {
        args = `-f "${formatId}+bestaudio/best" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
    }
    
    console.log(`🎬 Downloading with args: ${args}`);
    
    runYtDlp(args, async (error, stdout, stderr) => {
        if (error) {
            console.error('Download error:', stderr);
            return res.status(500).json({ error: 'Download failed', details: stderr });
        }
        
        try {
            const files = fs.readdirSync(downloadDir);
            const downloadedFile = files.find(f => f.startsWith(`${timestamp}_`));
            
            if (!downloadedFile) throw new Error('File not found');
            
            const filePath = path.join(downloadDir, downloadedFile);
            const fileSize = fs.statSync(filePath).size;
            const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
            
            const uploadResult = await uploadToBuzzheavier(filePath, downloadedFile);
            fs.unlink(filePath, () => {});
            
            if (!uploadResult.success) throw new Error(uploadResult.error);
            
            res.json({
                success: true,
                downloadUrl: uploadResult.downloadUrl,
                filename: downloadedFile,
                fileSize: sizeMB,
                service: 'Buzzheavier'
            });
            
        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: 'Upload failed', details: err.message });
        }
    });
});

// Debug endpoint
app.get('/api/debug', (req, res) => {
    res.json({
        workingYtDlp: workingYtDlp || 'Not found',
        commands: YTDLP_COMMANDS
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', ytDlp: workingYtDlp || 'not found' });
});

app.get('/', (req, res) => {
    res.json({
        name: 'YouTube Downloader API',
        version: '2.0.0',
        endpoints: {
            fetchInfo: 'POST /api/info',
            download: 'POST /api/download',
            debug: 'GET /api/debug',
            health: 'GET /health'
        }
    });
});

const PORT = process.env.PORT || 3000;

// Find yt-dlp and start server
findYtDlp().then((ytdlp) => {
    workingYtDlp = ytdlp;
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📺 yt-dlp: ${workingYtDlp || 'NOT FOUND'}`);
    });
});