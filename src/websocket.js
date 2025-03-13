require("dotenv").config();
const jwt = require("jsonwebtoken");
const { redisClient } = require("./config/redis");
const UserService = require("./services/UserService");
const MessageService = require("./services/MessageService");

const setupWebSocket = (io) => {
  // Middleware to authenticate socket connections
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        throw new Error("Authentication error");
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      next();
    } catch (error) {
      next(new Error("Authentication error"));
    }
  });

  // Handle socket connections
  io.on("connection", async (socket) => {
    const userId = socket.userId;

    // Join user's room
    socket.join(`user:${userId}`);

    // Update user's online status
    await UserService.updateOnlineStatus(userId, "online");

    // Subscribe to Redis channels
    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    // Handle new messages
    await subscriber.subscribe("new_message", async (message) => {
      const data = JSON.parse(message);
      const room = `conversation:${data.conversation}`;
      io.to(room).emit("new_message", data.message);
    });

    // Handle message read receipts
    await subscriber.subscribe("message_read", async (message) => {
      const data = JSON.parse(message);
      io.to(`conversation:${data.conversationId}`).emit("message_read", {
        userId: data.userId,
        conversationId: data.conversationId,
      });
    });

    // Handle message deletions
    await subscriber.subscribe("message_deleted", async (message) => {
      const data = JSON.parse(message);
      io.to(`conversation:${data.conversationId}`).emit("message_deleted", {
        messageId: data.messageId,
        conversationId: data.conversationId,
      });
    });

    // Handle joining conversations
    socket.on("join_conversation", (conversationId) => {
      socket.join(`conversation:${conversationId}`);
    });

    // Handle leaving conversations
    socket.on("leave_conversation", (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // Handle typing status
    socket.on("typing_start", (conversationId) => {
      socket.to(`conversation:${conversationId}`).emit("typing_start", {
        userId,
        conversationId,
      });
    });

    socket.on("typing_end", (conversationId) => {
      socket.to(`conversation:${conversationId}`).emit("typing_end", {
        userId,
        conversationId,
      });
    });

    // Handle disconnection
    socket.on("disconnect", async () => {
      await UserService.updateOnlineStatus(userId, "offline");
      await subscriber.quit();
    });
  });
};

module.exports = setupWebSocket;
