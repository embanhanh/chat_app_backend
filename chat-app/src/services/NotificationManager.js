const NotificationService = require("./NotificationService");
const { redisClient } = require("../config/redis");

class NotificationManager {
  constructor() {
    this.notificationService = NotificationService;
  }

  // Gửi thông báo tin nhắn mới
  async sendNewMessageNotification(message, recipients) {
    try {
      // Lưu thông báo vào Redis để hiển thị trong app
      await this.saveNotificationToRedis(message, recipients);

      // Gửi push notification
      await this.sendPushNotification(message, recipients);

      // Gửi WebSocket event
      await this.sendWebSocketEvent(message, recipients);

      return true;
    } catch (error) {
      console.error("Error sending new message notification:", error);
      return false;
    }
  }

  // Lưu thông báo vào Redis
  async saveNotificationToRedis(message, recipients) {
    try {
      const notification = {
        id: message._id,
        type: "new_message",
        content: message.content,
        senderId: message.senderId,
        conversationId: message.conversationId,
        createdAt: new Date(),
        readBy: [],
      };

      // Lưu cho từng người nhận
      for (const recipientId of recipients) {
        await redisClient.lPush(
          `notifications:${recipientId}`,
          JSON.stringify(notification)
        );
      }

      return true;
    } catch (error) {
      console.error("Error saving notification to Redis:", error);
      return false;
    }
  }

  // Gửi push notification
  async sendPushNotification(message, recipients) {
    try {
      const title = "Tin nhắn mới";
      const body = message.content;
      const data = {
        type: "new_message",
        messageId: message._id,
        conversationId: message.conversationId,
      };

      // Lấy device tokens của người nhận
      const deviceTokens = await this.getDeviceTokens(recipients);

      if (deviceTokens.length > 0) {
        await this.notificationService.sendToMultipleDevices(
          deviceTokens,
          title,
          body,
          data
        );
      }

      return true;
    } catch (error) {
      console.error("Error sending push notification:", error);
      return false;
    }
  }

  // Gửi WebSocket event
  async sendWebSocketEvent(message, recipients) {
    try {
      const event = {
        type: "new_message",
        message: message,
        conversationId: message.conversationId,
      };

      // Gửi event đến các người nhận
      for (const recipientId of recipients) {
        await redisClient.publish(`user:${recipientId}`, JSON.stringify(event));
      }

      return true;
    } catch (error) {
      console.error("Error sending WebSocket event:", error);
      return false;
    }
  }

  // Lấy device tokens của users
  async getDeviceTokens(userIds) {
    try {
      const tokens = [];
      for (const userId of userIds) {
        const user = await UserService.getUserById(userId);
        if (user && user.deviceToken) {
          tokens.push(user.deviceToken);
        }
      }
      return tokens;
    } catch (error) {
      console.error("Error getting device tokens:", error);
      return [];
    }
  }

  // Đánh dấu thông báo đã đọc
  async markNotificationAsRead(userId, notificationId) {
    try {
      const notifications = await redisClient.lRange(
        `notifications:${userId}`,
        0,
        -1
      );

      for (let i = 0; i < notifications.length; i++) {
        const notification = JSON.parse(notifications[i]);
        if (notification.id === notificationId) {
          notification.readBy.push(userId);
          await redisClient.lSet(
            `notifications:${userId}`,
            i,
            JSON.stringify(notification)
          );
          break;
        }
      }

      return true;
    } catch (error) {
      console.error("Error marking notification as read:", error);
      return false;
    }
  }

  // Lấy danh sách thông báo của user
  async getUserNotifications(userId, page = 1, limit = 20) {
    try {
      const start = (page - 1) * limit;
      const end = start + limit - 1;

      const notifications = await redisClient.lRange(
        `notifications:${userId}`,
        start,
        end
      );

      return notifications.map((notification) => JSON.parse(notification));
    } catch (error) {
      console.error("Error getting user notifications:", error);
      return [];
    }
  }
}

module.exports = new NotificationManager();
