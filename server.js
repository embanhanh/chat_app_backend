require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const WebRTCService = require('./src/webrtc');
const User = require('./src/models/User');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'token'],
    credentials: true
}));

// Kết nối MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chat_app')
    .then(() => console.log('✅ Kết nối MongoDB thành công'))
    .catch(err => {
        console.error('❌ Lỗi kết nối MongoDB:', err);
        process.exit(1);
    });

// Tạo HTTP server
const server = http.createServer(app);

// Cấu hình Socket.IO
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'token'],
        credentials: true
    },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

// Secret key cho JWT (trong thực tế nên đặt trong .env)
const JWT_SECRET = process.env.JWT_SECRET;

// Hàm tạo token test
function generateTestToken(userId) {
    return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' });
}

// API endpoint để lấy token test
app.get('/get-test-token/:userId', (req, res) => {
    const userId = req.params.userId;
    const token = generateTestToken(userId);
    res.json({ token });
});

// API đăng nhập để lấy token
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Tìm user
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ message: 'Tài khoản không tồn tại' });
        }

        // Kiểm tra password
        const isValidPassword = await user.comparePassword(password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Mật khẩu không chính xác' });
        }

        // Tạo token
        const token = jwt.sign(
            { id: user._id, username: user.username },
            process.env.JWT_SECRET || process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            user: {
                _id: user._id,
                username: user.username,
                email: user.email
            },
            token
        });
    } catch (error) {
        console.error('Lỗi đăng nhập:', error);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// API đăng ký
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Kiểm tra username đã tồn tại
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ message: 'Username đã tồn tại' });
        }

        // Tạo user mới
        const user = new User({ username, email, password });
        await user.save();

        // Tạo token
        const token = jwt.sign(
            { id: user._id, username: user.username },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );

        res.status(201).json({
            user: {
                _id: user._id,
                username: user.username,
                email: user.email
            },
            token
        });
    } catch (error) {
        console.error('Lỗi đăng ký:', error);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// Phục vụ file static
app.use(express.static(path.join(__dirname, 'test')));

// Phục vụ file test
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'test', 'webrtc-test.html'));
});

// Middleware xác thực Socket.IO
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.query.token || 
                     socket.handshake.headers.token || 
                     socket.handshake.auth.token;

        if (!token) {
            throw new Error('Authentication error: Token not provided');
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id;
        socket.username = decoded.username;

        // Log thông tin xác thực
        console.log('Socket authenticated:', {
            userId: socket.userId,
            username: socket.username,
            socketId: socket.id
        });

        next();
    } catch (error) {
        console.error('Socket authentication error:', error);
        next(new Error('Authentication error: ' + error.message));
    }
});

io.on('connection', (socket) => {
    console.log('Người dùng kết nối:', socket.id, 'User:', socket.username);

    // Join vào room của user
    socket.join(`user:${socket.userId}`);
    console.log(`User ${socket.username} joined room user:${socket.userId}`);

    // Khởi tạo WebRTC handlers
    WebRTCService.initializeWebRTCHandlers(io, socket);

    socket.on('disconnect', () => {
        console.log('Người dùng ngắt kết nối:', socket.username);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
}); 