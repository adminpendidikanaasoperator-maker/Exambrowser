const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// Konfigurasi file penyimpanan URL
const CONFIG_FILE = path.join(__dirname, 'config.json');
let currentGoogleFormUrl = '';
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (config.googleFormUrl) currentGoogleFormUrl = config.googleFormUrl;
    } catch(e) {}
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ googleFormUrl: currentGoogleFormUrl }, null, 2));
}

// Folder rekaman
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

const sessions = new Map();

// Multer upload video
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

// ---------- API Peserta ----------
app.post('/api/register', (req, res) => {
    const sessionId = uuidv4();
    const { participantName = 'Anonymous', nim = '', semester = '1' } = req.body;
    sessions.set(sessionId, {
        name: participantName,
        nim: nim,
        semester: semester,
        startTime: new Date().toISOString(),
        logs: [],
        videoPath: null
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

// ---------- API Admin ----------
app.get('/api/get-form-url', (req, res) => {
    res.json({ url: currentGoogleFormUrl });
});

app.post('/api/set-form-url', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    currentGoogleFormUrl = url;
    saveConfig();
    res.json({ success: true, url: currentGoogleFormUrl });
});

app.get('/api/sessions', (req, res) => {
    const semester = req.query.semester;
    let sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
        sessionId: id,
        name: data.name,
        nim: data.nim,
        semester: data.semester,
        startTime: data.startTime,
        logsCount: data.logs.length
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

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('admin-join', () => {
        socket.join('admin-room');
        console.log('Admin joined');
    });

    socket.on('participant-join', (sessionId) => {
        socket.join(`participant:${sessionId}`);
        const session = sessions.get(sessionId);
        const semester = session ? session.semester : 'unknown';
        console.log(`Participant ${sessionId} (Semester ${semester}) joined live stream`);
        const rooms = Array.from(io.sockets.adapter.rooms.keys());
        const activeParticipants = rooms
            .filter(r => r.startsWith('participant:'))
            .map(r => {
                const sid = r.split(':')[1];
                const sess = sessions.get(sid);
                return { sessionId: sid, semester: sess ? sess.semester : 'unknown', name: sess ? sess.name : sid };
            });
        io.to('admin-room').emit('active-participants', activeParticipants);
    });

    socket.on('live-frame', ({ sessionId, frame }) => {
        io.to('admin-room').emit('live-frame-update', { sessionId, frame });
    });

    socket.on('disconnect', () => {
        setTimeout(() => {
            const rooms = Array.from(io.sockets.adapter.rooms.keys());
            const activeParticipants = rooms
                .filter(r => r.startsWith('participant:'))
                .map(r => {
                    const sid = r.split(':')[1];
                    const sess = sessions.get(sid);
                    return { sessionId: sid, semester: sess ? sess.semester : 'unknown', name: sess ? sess.name : sid };
                });
            io.to('admin-room').emit('active-participants', activeParticipants);
        }, 1000);
    });
});

// ---------- Rute HTML ----------
app.get('/exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'exam.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

server.listen(PORT, () => {
    console.log(`ExamBrowser server running at http://localhost:${PORT}`);
});
