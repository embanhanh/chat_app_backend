const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const helmet = require("helmet");
const morgan = require("morgan");
require("dotenv").config();

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
  process.env.CHAT_SERVICE_URL || "http://chat-app-service:5000";

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

// Routes
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

// WebSocket proxy for chat application
app.use(
  "/socket.io",
  createProxyMiddleware({
    target: chatServiceUrl,
    changeOrigin: true,
    ws: true,
    logLevel: "debug",
    onProxyReqWs: (proxyReq, req, socket, options, head) => {
      // Set the correct host header
      proxyReq.setHeader("host", new URL(chatServiceUrl).host);

      console.log(
        `WebSocket connection being proxied to: ${chatServiceUrl}/socket.io`
      );
      console.log(`Original URL: ${req.url}`);
      console.log(`Target URL: ${proxyReq.path}`);
      console.log("WebSocket Headers:", req.headers);
    },
    onProxyReq: (proxyReq, req, res) => {
      // Set the correct host header for initial handshake
      proxyReq.setHeader("host", new URL(chatServiceUrl).host);
    },
    onProxyRes: (proxyRes, req, res) => {
      // Log successful responses
      console.log(`WebSocket proxy response: ${proxyRes.statusCode}`);
    },
    onError: (err, req, res) => {
      console.error(`WebSocket proxy error: ${err.message}`);
      console.error(err.stack);
    },
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
  const url = require("url");

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

const PORT = process.env.PORT || 3000;
const server = require("http").createServer(app);

// Use server instead of app.listen to properly handle WebSocket upgrades
server.listen(PORT, () => {
  console.log(`API Gateway is running on port ${PORT}`);
});
