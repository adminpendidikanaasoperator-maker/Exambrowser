const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// Konfigurasi file penyimpanan URL per semester
const CONFIG_FILE = path.join(__dirname, 'config.json');
let semesterUrls = {
    1: '',
    2: '',
    3: '',
    4: '',
    5: '',
    6: ''
};
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (config.semesterUrls) semesterUrls = config.semesterUrls;
    } catch(e) {}
}
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ semesterUrls }, null, 2));
}

// Folder rekaman
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

const sessions = new Map();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionId = req.params.sessionId;
        const sessionDir = path.join(RECORDINGS_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
        cb(null, sessionDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'recording.webm');
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } });

function getClientIp(req) {
    return req.headers['cf-connecting-ip'] ||
           req.headers['x-forwarded-for']?.split(',').shift() ||
           req.headers['x-real-ip'] ||
           req.socket.remoteAddress ||
           'IP tidak terdeteksi';
}

// API untuk mendapatkan URL form berdasarkan semester
app.get('/api/get-form-url/:semester', (req, res) => {
    const semester = req.params.semester;
    const url = semesterUrls[semester] || '';
    res.json({ url });
});

// API untuk admin mengatur URL per semester
app.post('/api/set-form-url', (req, res) => {
    const { semester, url } = req.body;
    if (!semester || !url) return res.status(400).json({ error: 'Semester and URL required' });
    semesterUrls[semester] = url;
    saveConfig();
    res.json({ success: true, semester, url });
});

// API untuk mendapat semua URL (untuk admin)
app.get('/api/all-form-urls', (req, res) => {
    res.json({ urls: semesterUrls });
});

// Register peserta
app.post('/api/register', (req, res) => {
    const sessionId = uuidv4();
    const { participantName = 'Anonymous', nim = '', semester = '1' } = req.body;
    const clientIp = getClientIp(req);
    sessions.set(sessionId, {
        name: participantName,
        nim: nim,
        semester: semester,
        startTime: new Date().toISOString(),
        logs: [],
        videoPath: null,
        clientIp: clientIp
    });
    res.json({ sessionId });
});

app.post('/api/log/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { message, type = 'cheat' } = req.body;
    if (sessions.has(sessionId)) {
        sessions.get(sessionId).logs.push({
            timestamp: new Date().toISOString(),
            message,
            type
        });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

app.post('/api/upload-chunk/:sessionId', upload.single('chunk'), (req, res) => {
    const { sessionId } = req.params;
    if (!sessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });
    if (req.file) {
        sessions.get(sessionId).videoPath = path.join(RECORDINGS_DIR, sessionId, 'recording.webm');
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No chunk received' });
    }
});

app.post('/api/end-recording/:sessionId', (req, res) => {
    res.json({ success: true });
});

app.get('/api/sessions', (req, res) => {
    const semester = req.query.semester;
    let sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
        sessionId: id,
        name: data.name,
        nim: data.nim,
        semester: data.semester,
        startTime: data.startTime,
        logsCount: data.logs.length,
        clientIp: data.clientIp
    }));
    if (semester && semester !== 'all') {
        sessionList = sessionList.filter(s => s.semester === semester);
    }
    res.json(sessionList);
});

app.get('/api/session/:sessionId/logs', (req, res) => {
    const { sessionId } = req.params;
    if (sessions.has(sessionId)) {
        res.json(sessions.get(sessionId).logs);
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

app.delete('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (sessions.has(sessionId)) {
        sessions.delete(sessionId);
        const sessionDir = path.join(RECORDINGS_DIR, sessionId);
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

app.get('/exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'exam.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
    console.log(`ExamBrowser server running at http://localhost:${PORT}`);
});
