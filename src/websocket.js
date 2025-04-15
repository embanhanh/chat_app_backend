require("dotenv").config();
const jwt = require("jsonwebtoken");
const { redisClient } = require("./config/redis");
const UserService = require("./services/UserService");
const MessageService = require("./services/MessageService");

// Tạo một global subscriber cho toàn bộ hệ thống
let globalSubscriber = null;
let isSubscribed = false;

// Xử lý tin nhắn mới từ Redis và gửi đến các clients
async function handleNewMessage(message) {
  try {
    const data = JSON.parse(message);
    const room = `conversation:${data.conversation}`;
    // Gửi đến tất cả clients trong room
    global.io.to(room).emit("new_message", {
      message: data.message,
      conversationId: data.conversation, //send conversationId to client
    });
  } catch (error) {
    console.error("Error handling new message:", error);
  }
}

async function handleGroupCreated(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, name, creatorId, participantIds, users } = data;

    // Thông báo cho tất cả thành viên (bao gồm người tạo)
    participantIds.forEach((userId) => {
      global.io.to(`user:${userId}`).emit("groupCreated", {
        type: "groupCreated",
        data: {
          conversationId,
          name,
          creatorId,
          users,
        },
      });
    });

    // Tự động yêu cầu các thành viên tham gia phòng
    participantIds.forEach((userId) => {
      global.io.to(`user:${userId}`).emit("joinConversation", {
        conversationId,
      });
    });
  } catch (error) {
    console.error("Error handling group created:", error);
  }
}

async function handleMemberAdded(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, users, newParticipantId } = data;

    // Phát sự kiện đến các thành viên hiện tại trong phòng
    global.io.to(`conversation:${conversationId}`).emit("memberAdded", {
      type: "memberAdded",
      data: {
        conversationId,
        users,
      },
    });

    // Thông báo cho người dùng mới để tham gia phòng
    global.io.to(`user:${newParticipantId}`).emit("addedToConversation", {
      conversationId,
    });
  } catch (error) {
    console.error("Error handling member added:", error);
  }
}

async function handleMemberRemoved(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, userId } = data;

    // Thông báo cho các thành viên hiện tại trong nhóm
    global.io.to(`conversation:${conversationId}`).emit("memberRemoved", {
      type: "memberRemoved",
      data: {
        conversationId,
        userId,
      },
    });

    // Thông báo cho người dùng bị xóa
    global.io.to(`user:${userId}`).emit("removedFromConversation", {
      conversationId,
    });
  } catch (error) {
    console.error("Error handling member removed:", error);
  }
}

// Xử lý đánh dấu đã đọc tin nhắn
async function handleMessageRead(message) {
  try {
    const data = JSON.parse(message);
    global.io.to(`conversation:${data.conversationId}`).emit("message_read", {
      userId: data.userId,
      conversationId: data.conversationId,
    });
  } catch (error) {
    console.error("Error handling message read:", error);
  }
}

// Xử lý xóa tin nhắn
async function handleMessageDeleted(message) {
  try {
    const data = JSON.parse(message);
    global.io
      .to(`conversation:${data.conversationId}`)
      .emit("message_deleted", {
        type: "messageDeleted",
        data: {
          conversationId: data.conversationId,
          messageId: data.messageId,
        },
      });
  } catch (error) {
    console.error("Error handling message deletion:", error);
  }
}

async function handleMessageEdited(message) {
  try {
    const data = JSON.parse(message);
    global.io.to(`conversation:${data.conversationId}`).emit("message_edited", {
      type: "messageUpdated",  
      data: {
        conversationId: data.conversationId,
        messageId: data.messageId,
        newContent: data.newContent,
        isEdited: data.isEdited,
      },
    });
  } catch (error) {
    console.error("Error handling message edited:", error);
  }
}

async function handleGroupNameUpdated(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, name, updatedBy } = data;

    // Thông báo cho tất cả thành viên trong nhóm
    global.io.to(`conversation:${conversationId}`).emit("groupNameUpdated", {
      type: "groupNameUpdated",
      data: {
        conversationId,
        name,
        updatedBy,
      },
    });
  } catch (error) {
    console.error("Error handling group name updated:", error);
  }
}

async function handleConversationDeleted(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, participantIds } = data;

    participantIds.forEach((userId) => {
      global.io.to(`user:${userId}`).emit("conversationDeleted", {
        type: "conversationDeleted",
        data: {
          conversationId,
        },
      });
    });

    global.io.to(`conversation:${conversationId}`).emit("leaveConversation", {
      conversationId,
    });
  } catch (error) {
    console.error("Error handling conversation deleted:", error);
  }
}

// Khởi tạo Redis subscribers
async function initRedisSubscribers() {
  if (isSubscribed) return;

  console.log("Initializing Redis subscribers...");
  globalSubscriber = redisClient.duplicate();
  await globalSubscriber.connect();

  // Đăng ký các kênh
  await globalSubscriber.subscribe("new_message", handleNewMessage);    
  await globalSubscriber.subscribe("message_read", handleMessageRead);
  await globalSubscriber.subscribe("message_deleted", handleMessageDeleted);
  await globalSubscriber.subscribe("message_edited", handleMessageEdited);
  await globalSubscriber.subscribe("member_added", handleMemberAdded);
  await globalSubscriber.subscribe("member_removed", handleMemberRemoved);
  await globalSubscriber.subscribe("group_created", handleGroupCreated);
  await globalSubscriber.subscribe("group_name_updated", handleGroupNameUpdated);
  await globalSubscriber.subscribe("conversation_deleted", handleConversationDeleted);

  isSubscribed = true;
  console.log("Redis subscribers initialized successfully");
}

const setupWebSocket = (io) => {
  // Lưu trữ io trong global để có thể truy cập từ các hàm xử lý Redis
  global.io = io;

  // Khởi tạo Redis subscribers
  initRedisSubscribers();

  // Middleware to authenticate socket connections
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token || socket.handshake.headers?.token;
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
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelay = 5000; // 5 seconds

    // Join user's room
    socket.join(`user:${userId}`);

    // Update user's online status
    await UserService.updateOnlineStatus(userId, "online");

    socket.on("test", (data) => {
      console.log(data);
    });

    // Handle joining conversations
    socket.on("join_conversation", (conversationId) => {
      try {
        socket.join(`conversation:${conversationId}`);
        console.log(`User ${userId} joined conversation ${conversationId}`);
      } catch (error) {
        console.error("Error joining conversation:", error);
        socket.emit("error", { message: "Lỗi khi tham gia cuộc trò chuyện" });
      }
    });

    // Handle leaving conversations
    socket.on("leave_conversation", (conversationId) => {
      try {
        socket.leave(`conversation:${conversationId}`);
      } catch (error) {
        console.error("Error leaving conversation:", error);
        socket.emit("error", { message: "Lỗi khi rời cuộc trò chuyện" });
      }
    });

    // Handle typing status
    socket.on("typing_start", (conversationId) => {
      try {
        socket.to(`conversation:${conversationId}`).emit("typing_start", {
          userId,
          conversationId,
        });
      } catch (error) {
        console.error("Error handling typing start:", error);
        socket.emit("error", { message: "Lỗi khi xử lý trạng thái đang nhập" });
      }
    });

    socket.on("typing_end", (conversationId) => {
      try {
        socket.to(`conversation:${conversationId}`).emit("typing_end", {
          userId,
          conversationId,
        });
      } catch (error) {
        console.error("Error handling typing end:", error);
        socket.emit("error", { message: "Lỗi khi xử lý trạng thái đang nhập" });
      }
    });

    // Handle socket errors
    socket.on("error", (error) => {
      console.error("Socket error:", error);
      socket.emit("error", { message: "Có lỗi xảy ra" });
    });

    // Handle disconnection
    socket.on("disconnect", async () => {
      try {
        await UserService.updateOnlineStatus(userId, "offline");
      } catch (error) {
        console.error("Error handling disconnection:", error);
      }
    });
  });
};

module.exports = setupWebSocket;
