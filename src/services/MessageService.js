const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const { redisClient } = require("../config/redis");
const admin = require("firebase-admin");

class MessageService {
  // Send a new message
  static async sendMessage(senderId, conversationId, messageData) {
    const conversation = await Conversation.findById(conversationId).populate(
      "participants.user"
    );

    if (!conversation) {
      throw { message: "Cuộc hội thoại không tồn tại" };
    }

    // Determine message content type if not provided
    if (!messageData.contentType) {
      if (
        messageData.media &&
        messageData.media.length > 0 &&
        messageData.content === ""
      ) {
        // Single media message (legacy support)
        messageData.contentType = "media";
      } else {
        // Plain text message and contentType remains "text" to support mixed content
        messageData.contentType = "text";
      }
    }

    // Create and save the message
    const message = new Message({
      sender: senderId,
      conversation: conversationId,
      content: messageData.content || "",
      contentType: messageData.contentType,
      media: messageData.media || [],
    });

    await message.save();

    // Update conversation's last message
    conversation.lastMessage = message._id;

    // Increment unread count for all participants except sender
    conversation.participants.forEach((participant) => {
      if (participant.user._id.toString() !== senderId.toString()) {
        const currentCount =
          conversation.unreadCount.get(participant.user._id.toString()) || 0;
        conversation.unreadCount.set(
          participant.user._id.toString(),
          currentCount + 1
        );
      }
    });

    await conversation.save();

    // Populate sender information before publishing
    await message.populate("sender", "username avatar _id");

    // Publish message to Redis for real-time delivery
    await redisClient.publish(
      "new_message",
      JSON.stringify({
        message,
        conversation: conversation._id,
      })
    );

    // Prepare notification content
    let notificationContent = messageData.content || "";
    if (messageData.media && messageData.media.length > 0) {
      const attachmentCount = messageData.media.length;
      const attachmentTypes = [
        ...new Set(messageData.media.map((a) => a.contentType)),
      ];

      // Tạo thông báo dựa vào loại file đính kèm
      if (attachmentTypes.length === 1) {
        // Tất cả file cùng loại
        const type = attachmentTypes[0];
        if (type === "image") {
          notificationContent =
            attachmentCount > 1
              ? `[${attachmentCount} hình ảnh]`
              : `[Hình ảnh]`;
        } else if (type === "video") {
          notificationContent =
            attachmentCount > 1 ? `[${attachmentCount} video]` : `[Video]`;
        } else if (type === "audio") {
          notificationContent =
            attachmentCount > 1
              ? `[${attachmentCount} file âm thanh]`
              : `[File âm thanh]`;
        } else {
          notificationContent =
            attachmentCount > 1
              ? `[${attachmentCount} tệp đính kèm]`
              : `[Tệp đính kèm]`;
        }
      } else {
        // Nhiều loại file khác nhau
        notificationContent = `[${attachmentCount} tệp đính kèm]`;
      }

      // Kết hợp với nội dung văn bản nếu có
      if (messageData.content && messageData.content.trim().length > 0) {
        notificationContent = `${messageData.content} ${notificationContent}`;
      }
    }

    // Send push notifications to offline users
    const offlineParticipants = conversation.participants.filter(
      (p) => p.user._id.toString() !== senderId.toString()
    );

    const notifications = offlineParticipants.flatMap((participant) =>
      (participant.user.fcmTokens || []).map(({ token }) => ({
        token,
        notification: {
          title:
            conversation.type === "group" ? conversation.name : "Tin nhắn mới",
          body: notificationContent.substring(0, 100),
        },
        data: {
          conversationId: conversation._id.toString(),
          messageId: message._id.toString(),
          type: "new_message",
        },
      }))
    );

    if (notifications.length > 0) {
      try {
        // Tạo đối tượng MulticastMessage
        const multicastMessage = {
          tokens: notifications.map((n) => n.token),
          notification: {
            title:
              conversation.type === "group"
                ? conversation.name
                : "Tin nhắn mới",
            body: notificationContent.substring(0, 100),
          },
          data: {
            conversationId: conversation._id.toString(),
            messageId: message._id.toString(),
            type: "new_message",
          },
        };

        // Sử dụng sendEachForMulticast để gửi thông báo đến tất cả token
        const response = await admin
          .messaging()
          .sendEachForMulticast(multicastMessage);

        if (response.failureCount > 0) {
          console.log(
            `${response.successCount} thông báo gửi thành công, ${response.failureCount} thông báo gửi thất bại`
          );
        }
      } catch (error) {
        console.error("Error sending push notifications:", error);
      }
    }

    return message;
  }

  // Mark messages as read
  static async markAsRead(userId, conversationId) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw { message: "Cuộc hội thoại không tồn tại" };
    }

    // Update read status for all messages in conversation
    await Message.updateMany(
      {
        conversation: conversationId,
        "readBy.user": { $ne: userId },
      },
      {
        $push: {
          readBy: {
            user: userId,
            readAt: new Date(),
          },
        },
      }
    );

    // Reset unread count for user
    conversation.unreadCount.set(userId.toString(), 0);
    await conversation.save();

    // Publish read receipt to Redis
    await redisClient.publish(
      "message_read",
      JSON.stringify({
        userId,
        conversationId,
      })
    );
  }

  // Get messages for a conversation with pagination
  static async getMessages(conversationId, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const messages = await Message.find({ conversation: conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sender", "username avatar")
      .lean();

    return messages.reverse();
  }

  // Delete message
  static async deleteMessage(messageId, userId) {
    const message = await Message.findById(messageId);

    if (!message) {
      throw { message: "Tin nhắn không tồn tại" };
    }

    if (message.sender.toString() !== userId.toString()) {
      throw { message: "Không có quyền xóa tin nhắn này" };
    }

    await message.remove();

    // Publish delete event to Redis
    await redisClient.publish(
      "message_deleted",
      JSON.stringify({
        messageId,
        conversationId: message.conversation,
      })
    );
  }
}

module.exports = MessageService;
