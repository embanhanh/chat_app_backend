const { redisClient } = require("../config/redis");

class RedisManager {
  constructor() {
    this.client = redisClient;
  }

  // Quản lý trạng thái online/offline
  async updateUserStatus(userId, status) {
    try {
      await this.client.set(`user:${userId}:status`, status);
      await this.client.publish(
        "user_status",
        JSON.stringify({ userId, status })
      );
      return true;
    } catch (error) {
      console.error("Error updating user status:", error);
      return false;
    }
  }

  // Quản lý typing status
  async updateTypingStatus(userId, conversationId, isTyping) {
    try {
      const key = `typing:${conversationId}:${userId}`;
      if (isTyping) {
        await this.client.set(key, "1", "EX", 5); // 5 giây timeout
      } else {
        await this.client.del(key);
      }
      await this.client.publish(
        `conversation:${conversationId}`,
        JSON.stringify({
          type: "typing_status",
          userId,
          isTyping,
        })
      );
      return true;
    } catch (error) {
      console.error("Error updating typing status:", error);
      return false;
    }
  }

  // Quản lý message read status
  async updateMessageReadStatus(messageId, userId, conversationId) {
    try {
      await this.client.sAdd(`message:${messageId}:read_by`, userId);
      await this.client.publish(
        `conversation:${conversationId}`,
        JSON.stringify({
          type: "message_read",
          messageId,
          userId,
        })
      );
      return true;
    } catch (error) {
      console.error("Error updating message read status:", error);
      return false;
    }
  }

  async publishGroupCreated({ conversationId, name, creatorId, participantIds, users }) {
    try {
      await this.client.publish(
        "group_created",
        JSON.stringify({
          conversationId,
          name,
          creatorId,
          participantIds,
          users,
        })
      );
      return true;
    } catch (error) {
      console.error("Error publishing group created:", error);
      return false;
    }
  }

  // Quản lý conversation participants
  async addConversationParticipant(conversationId, userId, userInfo) {
    try {
      console.log(`Adding participant ${userId} to conversation ${conversationId}`);
      await this.client.sAdd(
        `conversation:${conversationId}:participants`,
        userId
      );
      console.log(`Publishing member_added for conversation ${conversationId}, user ${userId}`);
      await this.client.publish(
        "member_added",
        JSON.stringify({
          conversationId,
          users: userInfo, // { avatarUrl, name }
          newParticipantId: userId,
        })
      );
      console.log(`Published member_added for conversation ${conversationId}`);
      return true;
    } catch (error) {
      console.error("Error adding conversation participant:", error);
      return false;
    }
  }

  async removeConversationParticipant(conversationId, userId) {
    try {
      // Xóa userId khỏi tập hợp participants
      await this.client.sRem(
        `conversation:${conversationId}:participants`,
        userId
      );

      // Xuất bản sự kiện member_removed
      await this.client.publish(
        "member_removed",
        JSON.stringify({
          conversationId,
          userId,
        })
      );

      return true;
    } catch (error) {
      console.error("Error removing conversation participant:", error);
      return false;
    }
  }

  // Quản lý group name update
  async publishGroupNameUpdated({ conversationId, name, updatedBy }) {
    try {
      if (typeof conversationId !== "string") {
        throw new Error("conversationId phải là chuỗi");
      }
      await this.client.publish(
        "group_name_updated",
        JSON.stringify({
          conversationId,
          name,
          updatedBy,
        })
      );
      return true;
    } catch (error) {
      console.error("Error publishing group name updated:", error);
      throw error;
    }
  }

  async deleteConversationData(conversationId, participantIds) {
    try {
      if (typeof conversationId !== "string") {
        throw new Error("conversationId phải là chuỗi");
      }
      await this.client.del(`conversation:${conversationId}:participants`);
      for (const userId of participantIds) {
        const typingKey = `typing:${conversationId}:${userId}`;
        await this.client.del(typingKey);
      }
      return true;
    } catch (error) {
      console.error("Error deleting conversation data:", error);
      throw error;
    }
  }
  
  async publishConversationDeleted({ conversationId, participantIds }) {
    try {
      if (typeof conversationId !== "string") {
        throw new Error("conversationId phải là chuỗi");
      }
      await this.client.publish(
        "conversation_deleted",
        JSON.stringify({
          conversationId,
          participantIds,
        })
      );
      return true;
    } catch (error) {
      console.error("Error publishing conversation deleted:", error);
      throw error;
    }
  }

  // Quản lý user sessions
  async addUserSession(userId, sessionId) {
    try {
      await this.client.sAdd(`user:${userId}:sessions`, sessionId);
      return true;
    } catch (error) {
      console.error("Error adding user session:", error);
      return false;
    }
  }

  async removeUserSession(userId, sessionId) {
    try {
      await this.client.sRem(`user:${userId}:sessions`, sessionId);
      return true;
    } catch (error) {
      console.error("Error removing user session:", error);
      return false;
    }
  }

  // Quản lý rate limiting
  async checkRateLimit(key, limit, window) {
    try {
      const current = await this.client.incr(key);
      if (current === 1) {
        await this.client.expire(key, window);
      }
      return current <= limit;
    } catch (error) {
      console.error("Error checking rate limit:", error);
      return false;
    }
  }

  // Quản lý cache
  async setCache(key, value, ttl = 3600) {
    try {
      await this.client.set(key, JSON.stringify(value), "EX", ttl);
      return true;
    } catch (error) {
      console.error("Error setting cache:", error);
      return false;
    }
  }

  async getCache(key) {
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error("Error getting cache:", error);
      return null;
    }
  }

  async deleteCache(key) {
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error("Error deleting cache:", error);
      return false;
    }
  }
}

module.exports = new RedisManager();
