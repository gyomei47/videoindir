const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static('downloads'));

// Active downloads tracking
const activeDownloads = new Map();

// Refresh PATH to pick up newly installed tools
function getRefreshedPath() {
  try {
    const machinePath = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"', { encoding: 'utf-8' }).trim();
    const userPath = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"', { encoding: 'utf-8' }).trim();
    return machinePath + ';' + userPath;
  } catch {
    return process.env.PATH;
  }
}

const refreshedPath = getRefreshedPath();

// Cookie file path (optional)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');

function getCookieArgs() {
  if (fs.existsSync(COOKIES_FILE)) {
    console.log('Using cookies file:', COOKIES_FILE);
    return ['--cookies', COOKIES_FILE];
  }
  return [];
}

// Get video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  try {
    const args = [
      '--dump-json',
      '--no-playlist',
      ...getCookieArgs(),
      url
    ];

    const proc = spawn('yt-dlp', args, {
      env: { ...process.env, PATH: refreshedPath },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('yt-dlp info error:', stderr);
        return res.status(500).json({ error: 'Video bilgisi alınamadı: ' + stderr.substring(0, 500) });
      }
      try {
        const info = JSON.parse(stdout);
        
        // Build format list
        const formats = [];
        const seen = new Set();

        // Add best video+audio merge options
        const heights = [2160, 1440, 1080, 720, 480, 360];
        for (const h of heights) {
          // Check if this height exists in available formats
          const hasHeight = info.formats?.some(f => f.height >= h && f.vcodec && f.vcodec !== 'none');
          if (hasHeight) {
            const label = `${h}p - MP4 (en iyi kalite)`;
            formats.push({
              format_id: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
              label,
              height: h,
              ext: 'mp4',
              size: 0,
              type: 'merged'
            });
          }
        }

        // Video + Audio combined formats (direct, no merge needed)
        if (info.formats) {
          for (const f of info.formats) {
            if (f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none') {
              const label = `${f.height || '?'}p - ${f.ext} (${formatSize(f.filesize || f.filesize_approx)}) [direkt]`;
              const key = `${f.height}-${f.ext}-direct`;
              if (!seen.has(key)) {
                seen.add(key);
                formats.push({
                  format_id: f.format_id,
                  label,
                  height: f.height || 0,
                  ext: f.ext,
                  size: f.filesize || f.filesize_approx || 0,
                  type: 'video'
                });
              }
            }
          }
        }

        // Audio only
        formats.push({
          format_id: 'bestaudio',
          label: 'Sadece Ses - MP3 (en iyi kalite)',
          height: 0,
          ext: 'mp3',
          size: 0,
          type: 'audio'
        });

        // Sort: merged first by height desc, then combined by height desc, then audio
        formats.sort((a, b) => {
          const order = { merged: 0, video: 1, audio: 2 };
          if (order[a.type] !== order[b.type]) return order[a.type] - order[b.type];
          return b.height - a.height;
        });

        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          uploader: info.uploader,
          view_count: info.view_count,
          formats
        });
      } catch (e) {
        console.error('Parse error:', e);
        res.status(500).json({ error: 'Video bilgisi çözümlenemedi' });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start download
app.post('/api/download', (req, res) => {
  const { url, format_id, type } = req.body;
  if (!url) return res.status(400).json({ error: 'URL gerekli' });

  const downloadId = uuidv4();
  const downloadsDir = path.join(__dirname, 'downloads');
  
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

  const outputTemplate = path.join(downloadsDir, `${downloadId}_%(title)s.%(ext)s`);

  let args = [
    '--no-playlist',
    ...getCookieArgs(),
    '--newline',
    '--progress',
    '-o', outputTemplate,
  ];

  if (type === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (type === 'merged') {
    args.push('-f', format_id, '--merge-output-format', 'mp4');
  } else if (format_id) {
    args.push('-f', format_id);
  } else {
    args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--merge-output-format', 'mp4');
  }

  args.push(url);

  console.log(`Starting download ${downloadId}:`, 'yt-dlp', args.join(' '));

  const proc = spawn('yt-dlp', args, {
    env: { ...process.env, PATH: refreshedPath },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const downloadInfo = {
    id: downloadId,
    status: 'downloading',
    progress: 0,
    speed: '',
    eta: '',
    filename: '',
    error: ''
  };

  activeDownloads.set(downloadId, downloadInfo);

  let stderrLog = '';

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      // Parse progress: [download]  45.3% of  123.45MiB at  5.67MiB/s ETA 00:15
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+(\S+)/);
      if (progressMatch) {
        downloadInfo.progress = parseFloat(progressMatch[1]);
        downloadInfo.totalSize = progressMatch[2];
        downloadInfo.speed = progressMatch[3];
        downloadInfo.eta = progressMatch[4];
      }

      // Check for merge
      if (line.includes('[Merger]') || line.includes('[ffmpeg]') || line.includes('[ExtractAudio]')) {
        downloadInfo.status = 'merging';
        downloadInfo.progress = 100;
      }

      // Check for destination
      const destMatch = line.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        downloadInfo.filename = path.basename(destMatch[1]);
      }

      // Already downloaded
      if (line.includes('has already been downloaded')) {
        const alreadyMatch = line.match(/\[download\] (.+) has already been downloaded/);
        if (alreadyMatch) {
          downloadInfo.filename = path.basename(alreadyMatch[1]);
          downloadInfo.progress = 100;
        }
      }
    }
  });

  proc.stderr.on('data', (data) => {
    stderrLog += data.toString();
    console.error('yt-dlp stderr:', data.toString());
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      downloadInfo.status = 'error';
      downloadInfo.error = stderrLog.substring(0, 500);
      console.error(`Download ${downloadId} failed:`, stderrLog);
    } else {
      downloadInfo.status = 'completed';
      downloadInfo.progress = 100;

      // Find the actual file
      const files = fs.readdirSync(downloadsDir).filter(f => f.startsWith(downloadId));
      if (files.length > 0) {
        // prefer final file over part/temp files
        const finalFile = files.find(f => !f.endsWith('.part') && !f.endsWith('.temp') && !f.endsWith('.webm.part')) || files[0];
        downloadInfo.filename = finalFile;
      }

      console.log(`Download ${downloadId} completed: ${downloadInfo.filename}`);
    }
  });

  res.json({ downloadId });
});

// Check download progress
app.get('/api/progress/:id', (req, res) => {
  const info = activeDownloads.get(req.params.id);
  if (!info) return res.status(404).json({ error: 'İndirme bulunamadı' });
  res.json(info);
});

// Download completed file
app.get('/api/file/:id', (req, res) => {
  const info = activeDownloads.get(req.params.id);
  if (!info || info.status !== 'completed') {
    return res.status(404).json({ error: 'Dosya hazır değil' });
  }

  const filePath = path.join(__dirname, 'downloads', info.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Dosya bulunamadı' });
  }

  // Clean filename (remove uuid prefix)
  const cleanName = info.filename.replace(/^[a-f0-9-]+_/, '');
  res.download(filePath, cleanName);
});

// Cleanup old files (older than 1 hour)
setInterval(() => {
  const downloadsDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) return;
  
  const files = fs.readdirSync(downloadsDir);
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(downloadsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up: ${file}`);
      }
    } catch {}
  }
}, 600000);

function formatSize(bytes) {
  if (!bytes) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(1) + ' ' + units[i];
}

app.listen(PORT, () => {
  console.log(`🎬 VideoIndir sunucusu çalışıyor: http://localhost:${PORT}`);
  console.log(`Cookie dosyası: ${fs.existsSync(COOKIES_FILE) ? 'MEVCUT ✅' : 'YOK (cookie olmadan çalışılacak)'}`);
});
