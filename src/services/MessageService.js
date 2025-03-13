const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const { redisClient } = require("../config/redis");
const admin = require("firebase-admin");

class MessageService {
  // Send a new message
  static async sendMessage(senderId, conversationId, messageData) {
    const conversation = await Conversation.findById(conversationId).populate(
      "participants.user",
      "fcmTokens"
    );

    if (!conversation) {
      throw new Error("Conversation not found");
    }

    // Create and save the message
    const message = new Message({
      sender: senderId,
      conversation: conversationId,
      ...messageData,
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

    // Publish message to Redis for real-time delivery
    await redisClient.publish(
      "new_message",
      JSON.stringify({
        message,
        conversation: conversation._id,
      })
    );

    // Send push notifications to offline users
    const offlineParticipants = conversation.participants.filter(
      (p) => p.user._id.toString() !== senderId.toString()
    );

    const notifications = offlineParticipants.flatMap((participant) =>
      participant.user.fcmTokens.map(({ token }) => ({
        token,
        notification: {
          title:
            conversation.type === "group" ? conversation.name : "New Message",
          body: messageData.content.substring(0, 100),
        },
        data: {
          conversationId: conversation._id.toString(),
          messageId: message._id.toString(),
          type: "new_message",
        },
      }))
    );

    if (notifications.length > 0) {
      await admin.messaging().sendAll(notifications);
    }

    return message;
  }

  // Mark messages as read
  static async markAsRead(userId, conversationId) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found");
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
      throw new Error("Message not found");
    }

    if (message.sender.toString() !== userId.toString()) {
      throw new Error("Unauthorized to delete this message");
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
