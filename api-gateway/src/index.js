const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const helmet = require("helmet");
const morgan = require("morgan");
require("dotenv").config();
const http = require("http");
const url = require("url");

const app = express();

// CORS configuration
const corsOptions = {
  origin: "*", // In production, replace with your frontend domain
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Type"],
  maxAge: 86400,
};

// Middleware
app.use(cors(corsOptions));
app.use(helmet());
app.use(morgan("dev"));
// Only parse JSON for non-proxied routes
app.use(/^\/((?!api).)*$/, express.json());

// Service URLs - Use environment variables for service discovery
const chatServiceUrl =
  process.env.CHAT_SERVICE_URL || "http://chat-app-backend:5000";

// Log the service URL for debugging
console.log(`Chat Service URL: ${chatServiceUrl}`);

// Proxy options
const proxyOptions = {
  changeOrigin: true,
  pathRewrite: {
    "^/api/auth": "/api/auth",
    "^/api/users": "/api/users",
    "^/api/conversations": "/api/conversations",
    "^/api/messages": "/api/messages",
    "^/api/notifications": "/api/notifications",
    "^/api/files": "/api/files",
    "^/api/search": "/api/search",
  },
  onProxyReq: (proxyReq, req, res) => {
    // If the request contains a body and the content-type is json, restream the body
    if (
      req.body &&
      req.headers["content-type"] &&
      req.headers["content-type"].includes("application/json")
    ) {
      const bodyData = JSON.stringify(req.body);

      // Update content-length
      proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));

      // Write body to request
      proxyReq.write(bodyData);
      proxyReq.end();
    }

    console.log(`Proxying request to: ${req.method} ${proxyReq.path}`);
  },
  onError: (err, req, res) => {
    console.error(`Proxy error: ${err.message}`);
    console.error(`Failed connecting to: ${chatServiceUrl}`);
    res
      .status(500)
      .json({ error: "Service unavailable", details: err.message });
  },
};

// Regular API routes
app.use(
  "/api/auth",
  express.json(), // Parse JSON for auth routes
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

app.use(
  "/api/users",
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

app.use(
  "/api/conversations",
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

app.use(
  "/api/messages",
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

app.use(
  "/api/notifications",
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

app.use(
  "/api/files",
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

app.use(
  "/api/search",
  createProxyMiddleware({
    target: chatServiceUrl,
    ...proxyOptions,
  })
);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "API Gateway is running" });
});

// Debug endpoint to check service connections
app.get("/debug/services", (req, res) => {
  const dns = require("dns").promises;

  // Try to resolve the chat service hostname
  const chatServiceHost = new URL(chatServiceUrl).hostname;

  dns
    .lookup(chatServiceHost)
    .then((result) => {
      res.status(200).json({
        services: {
          chatService: chatServiceUrl,
          chatServiceResolved: {
            host: chatServiceHost,
            ip: result.address,
            family: `IPv${result.family}`,
          },
        },
        env: process.env.NODE_ENV,
        kubernetes: {
          namespace: process.env.KUBERNETES_NAMESPACE || "unknown",
          podName: process.env.HOSTNAME || "unknown",
        },
      });
    })
    .catch((err) => {
      res.status(200).json({
        services: {
          chatService: chatServiceUrl,
          chatServiceResolved: {
            error: err.message,
          },
        },
        env: process.env.NODE_ENV,
        kubernetes: {
          namespace: process.env.KUBERNETES_NAMESPACE || "unknown",
          podName: process.env.HOSTNAME || "unknown",
        },
      });
    });
});

// Network test endpoint
app.get("/debug/test-connection", async (req, res) => {
  const net = require("net");

  try {
    const serviceUrl = new URL(chatServiceUrl);
    const host = serviceUrl.hostname;
    const port = parseInt(serviceUrl.port) || 5000;

    console.log(`Testing connection to ${host}:${port}`);

    const socket = new net.Socket();
    const connectPromise = new Promise((resolve, reject) => {
      socket.connect(port, host, () => {
        resolve(true);
      });

      socket.on("error", (err) => {
        reject(err);
      });
    });

    const timeout = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error("Connection timeout after 5 seconds"));
      }, 5000);
    });

    await Promise.race([connectPromise, timeout]);
    socket.end();

    res.status(200).json({
      success: true,
      message: `Successfully connected to ${host}:${port}`,
      service: chatServiceUrl,
    });
  } catch (err) {
    res.status(200).json({
      success: false,
      message: `Failed to connect: ${err.message}`,
      service: chatServiceUrl,
    });
  }
});

// WebSocket specific debug endpoint
app.get("/debug/ws-connection", async (req, res) => {
  const WebSocket = require('ws');

  try {
    const serviceUrl = new URL(chatServiceUrl);
    const host = serviceUrl.hostname;
    const port = parseInt(serviceUrl.port) || 5000;
    const wsUrl = `ws://${host}:${port}/socket.io/?EIO=4&transport=websocket`;

    console.log(`Testing WebSocket connection to ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    const connectPromise = new Promise((resolve, reject) => {
      ws.on('open', () => {
        resolve(true);
      });

      ws.on('error', (err) => {
        reject(err);
      });
    });

    const timeout = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error("WebSocket connection timeout after 5 seconds"));
      }, 5000);
    });

    await Promise.race([connectPromise, timeout]);
    ws.close();

    res.status(200).json({
      success: true,
      message: `Successfully connected to WebSocket at ${wsUrl}`,
      service: chatServiceUrl
    });
  } catch (err) {
    res.status(200).json({
      success: false,
      message: `Failed to connect WebSocket: ${err.message}`,
      service: chatServiceUrl
    });
  }
});

// WebSocket test UI
app.get("/debug/ws-test", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WebSocket Test</title>
      <script src="https://cdn.socket.io/4.4.1/socket.io.min.js"></script>
      <script>
        function connectWebSocket() {
          const token = document.getElementById('token').value;
          const url = document.getElementById('wsUrl').value || window.location.origin;
          
          document.getElementById('status').innerText = 'Connecting...';
          document.getElementById('logs').innerHTML = '';
          
          const addLog = (msg) => {
            const logElem = document.createElement('div');
            logElem.innerText = new Date().toISOString() + ': ' + msg;
            document.getElementById('logs').appendChild(logElem);
          };
          
          addLog('Creating connection to ' + url);
          
          const socket = io(url, {
            transports: ['websocket'],
            path: '/socket.io',
            auth: { token },
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            timeout: 20000
          });
          
          socket.on('connect', () => {
            document.getElementById('status').innerText = 'Connected! Socket ID: ' + socket.id;
            document.getElementById('status').style.color = 'green';
            addLog('Connected with socket ID: ' + socket.id);
          });
          
          socket.on('connect_error', (err) => {
            document.getElementById('status').innerText = 'Connection Error: ' + err.message;
            document.getElementById('status').style.color = 'red';
            addLog('Connection error: ' + err.message);
            console.error('Connection error:', err);
          });
          
          socket.on('disconnect', (reason) => {
            document.getElementById('status').innerText = 'Disconnected: ' + reason;
            document.getElementById('status').style.color = 'orange';
            addLog('Disconnected: ' + reason);
          });
          
          socket.on('error', (err) => {
            document.getElementById('status').innerText = 'Socket Error: ' + (err.message || err);
            document.getElementById('status').style.color = 'red';
            addLog('Socket error: ' + (err.message || err));
          });
          
          socket.io.on('reconnect_attempt', () => {
            addLog('Attempting to reconnect...');
          });
          
          socket.io.on('reconnect', (attempt) => {
            addLog('Reconnected after ' + attempt + ' attempts');
            document.getElementById('status').innerText = 'Reconnected! Socket ID: ' + socket.id;
            document.getElementById('status').style.color = 'green';
          });
          
          window.socket = socket;
          return false;
        }
        
        function sendPing() {
          if (!window.socket || !window.socket.connected) {
            alert('Not connected to WebSocket');
            return;
          }
          
          const addLog = (msg) => {
            const logElem = document.createElement('div');
            logElem.innerText = new Date().toISOString() + ': ' + msg;
            document.getElementById('logs').appendChild(logElem);
          };
          
          addLog('Sending ping message');
          window.socket.emit('ping', { time: new Date().toISOString() }, (response) => {
            addLog('Received response: ' + JSON.stringify(response));
          });
        }
      </script>
    </head>
    <body>
      <h1>WebSocket Connection Test</h1>
      <form onsubmit="return connectWebSocket()">
        <div>
          <label for="wsUrl">WebSocket URL (leave empty for current origin):</label><br>
          <input type="text" id="wsUrl" style="width: 100%;" placeholder="http://localhost">
        </div>
        <div style="margin-top: 10px;">
          <label for="token">Authentication Token:</label><br>
          <input type="text" id="token" style="width: 100%;" placeholder="JWT Token">
        </div>
        <div style="margin-top: 10px;">
          <button type="submit">Connect WebSocket</button>
          <button type="button" onclick="sendPing()">Send Ping</button>
        </div>
      </form>
      <div style="margin-top: 20px;">
        <strong>Status:</strong> <span id="status">Not connected</span>
      </div>
      <div style="margin-top: 10px;">
        <strong>Connection Logs:</strong>
        <div id="logs" style="height: 200px; overflow-y: auto; border: 1px solid #ccc; padding: 5px; margin-top: 5px;"></div>
      </div>
    </body>
    </html>
  `);
});

// Tạo HTTP server
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Tạo proxy dành riêng cho WebSocket với cấu hình chi tiết
const wsProxy = createProxyMiddleware('/socket.io', {
  target: chatServiceUrl,
  changeOrigin: true,
  ws: true,
  logLevel: 'debug',
  pathRewrite: undefined, // Không rewrite path cho WebSocket
  secure: false,
  xfwd: true, // Forward original headers
  timeout: 60000,
  proxyTimeout: 60000,
  // Không dùng onProxyReqWs và onProxyReq ở đây vì sẽ xử lý trực tiếp trong event upgrade
});

// Đăng ký middleware proxy cho các request HTTP thông thường
app.use('/socket.io', wsProxy);

// Xử lý nâng cấp kết nối WebSocket trực tiếp
server.on('upgrade', (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;

  console.log(`[UPGRADE] Received upgrade request for: ${req.url}`);
  console.log(`[UPGRADE] Headers: ${JSON.stringify(req.headers)}`);

  // Xử lý Socket.IO
  if (req.url.startsWith('/socket.io/')) {
    console.log(`[UPGRADE] Socket.IO upgrade request with full URL: ${req.url}`);

    try {
      // Thiết lập timeout dài hơn cho socket này
      socket.setTimeout(60000);

      // Logging các header quan trọng
      const upgrade = req.headers['upgrade'];
      const connection = req.headers['connection'];
      console.log(`[UPGRADE] Upgrade header: ${upgrade}`);
      console.log(`[UPGRADE] Connection header: ${connection}`);

      // Bắt xử lý lỗi cho socket để tránh crash
      socket.on('error', (err) => {
        console.error(`[UPGRADE] Socket error: ${err.message}`);
      });

      // Chuyển upgrade request đến proxy WebSocket
      console.log(`[UPGRADE] Proxying Socket.IO upgrade to: ${chatServiceUrl}`);
      wsProxy.upgrade(req, socket, head);
    } catch (err) {
      console.error(`[UPGRADE] Error during upgrade: ${err.message}`, err);
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    }
  } else {
    // Các upgrade request không liên qian đến socket.io
    console.log(`[UPGRADE] Non-Socket.IO upgrade request for ${pathname}, closing`);
    socket.destroy();
  }
});

// Thêm endpoint debug đặc biệt cho việc kiểm tra trạng thái proxy
app.get('/debug/proxy-status', (req, res) => {
  const proxy = wsProxy.proxy;

  res.json({
    proxyActive: !!proxy,
    openSockets: proxy ? Object.keys(proxy.ws || {}).length : 0,
    wsRouteRegistered: !!app._router.stack.find(layer =>
      layer.route && layer.route.path === '/socket.io'
    ),
    upgradeHandlerRegistered: server.listenerCount('upgrade') > 0,
    chatServiceUrl: chatServiceUrl
  });
});

// Khởi động server
server.listen(PORT, () => {
  console.log(`API Gateway is running on port ${PORT}`);
  console.log(`WebSocket proxy configured for ${chatServiceUrl}/socket.io`);
});