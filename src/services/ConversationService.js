const Conversation = require("../models/Conversation");
const User = require("../models/User");
const FileService = require("./FileService");
const RedisManager = require("./RedisManager");

class ConversationService {
  // Get conversation by id
  static async getConversationById(conversationId) {
    const conversation = await Conversation.findById(conversationId).populate(
      "participants.user",
      "username avatar status"
    ); // Lấy thông tin chi tiết của thành viên

    if (!conversation) {
      throw { message: "Cuộc hội thoại không tồn tại" };
    }

    // Tìm người có role "admin"
    const admin = conversation.participants.find((p) => p.role === "admin");

    // Định dạng kết quả trả về
    return {
      conversationId: conversation._id,
      type: conversation.type,
      name: conversation.name || null,
      members: conversation.participants.map((p) => ({
        userId: p.user._id,
        username: p.user.username,
        avatar: p.user.avatar,
        status: p.user.status,
      })),
      quickEmojis: conversation.quickEmojis || null,
      avatarUrl: conversation.avatar || null,
      creator: admin
        ? {
            userId: admin.user._id,
            username: admin.user.username,
            avatar: admin.user.avatar,
            status: admin.user.status,
          }
        : null, // Nếu không có admin, trả về null
      createdAt: conversation.createdAt,
    };
  }
  // Create a new private conversation
  static async createPrivateConversation(userId1, userId2) {
    // Check if conversation already exists
    const existingConversation = await Conversation.findOne({
      type: "private",
      "participants.user": { $all: [userId1, userId2] },
    });

    if (existingConversation) {
      return { conversationId: existingConversation._id };
    }

    // Create new conversation
    const conversation = new Conversation({
      type: "private",
      participants: [{ user: userId1 }, { user: userId2 }],
    });

    await conversation.save();
    return {
      conversationId: conversation._id,
    };
  }

  // Create a new group conversation
  static async createGroupConversation(
    name,
    creatorId,
    participantIds,
    conversationId = null
  ) {
    if (conversationId) {
      const conversation = await Conversation.findById(conversationId);
      if (conversation) {
        return { conversationId: conversation._id };
      }
    }

    // Chuyển tất cả ID thành chuỗi và loại bỏ trùng lặp
    const creatorIdStr = creatorId.toString();
    const participantIdsStr = [
      ...new Set(participantIds.map((id) => id.toString())),
    ].filter((id) => id !== creatorIdStr);
    const allParticipants = [creatorIdStr, ...participantIdsStr];

    // Verify all participants exist
    const users = await User.find({ _id: { $in: allParticipants } }).select(
      "username avatar"
    );
    if (users.length !== allParticipants.length) {
      throw {
        message: "Một hoặc nhiều người dùng không tồn tại",
        statusCode: 404,
      };
    }

    // Tạo map để tra cứu userInfo hiệu quả
    const userInfoMap = users.reduce((map, user) => {
      map[user._id.toString()] = {
        avatarUrl: user.avatar,
        name: user.username,
      };
      return map;
    }, {});

    const conversation = new Conversation({
      type: "group",
      name,
      participants: [
        { user: creatorIdStr, role: "admin" },
        ...participantIdsStr.map((id) => ({ user: id })),
      ],
      updatedAt: new Date(),
    });

    await conversation.save();

    // Đồng bộ với Redis
    await Promise.all(
      allParticipants.map((userId) =>
        RedisManager.addConversationParticipant(
          conversation._id.toString(), // Đảm bảo là chuỗi
          userId,
          userInfoMap[userId]
        )
      )
    );

    // Publish sự kiện group_created
    await RedisManager.publishGroupCreated({
      conversationId: conversation._id.toString(),
      name,
      creatorId: creatorIdStr,
      participantIds: participantIdsStr,
      users: users.map((u) => ({
        userId: u._id.toString(),
        avatarUrl: u.avatar,
        name: u.username,
      })),
    });

    return { conversationId: conversation._id };
  }

  // Update group conversation name
  static async updateGroupConversationName(conversationId, userId, name) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation || conversation.type !== "group") {
      throw { message: "Cuộc hội thoại nhóm không tồn tại", statusCode: 404 };
    }

    // Kiểm tra quyền admin (thay vì chỉ là thành viên)
    const participant = conversation.participants.find(
      (p) => p.user.toString() === userId.toString()
    );
    if (!participant || participant.role !== "admin") {
      throw { message: "Chỉ admin mới có thể sửa tên nhóm", statusCode: 403 };
    }

    conversation.name = name;
    conversation.updatedAt = new Date(); // Cập nhật thời gian để sắp xếp
    await conversation.save();

    // Publish sự kiện group_name_updated
    await RedisManager.publishGroupNameUpdated({
      conversationId: conversation._id.toString(),
      name,
      updatedBy: userId,
    });

    return {
      conversationId: conversation._id,
      name: conversation.name,
    };
  }
  // Update group conversation avatar
  static async updateGroupConversationAvatar(conversationId, userId, avatar) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation || conversation.type !== "group") {
      throw { message: "Cuộc hội thoại nhóm không tồn tại" };
    }

    if (
      !conversation.participants.find(
        (p) => p.user.toString() === userId.toString()
      )
    ) {
      throw { message: "Bạn không có quyền sửa avatar nhóm" };
    }

    if (avatar) {
      const fileUpload = await FileService.uploadToS3(avatar, "group_avatar");
      conversation.avatar = fileUpload.url;
      await conversation.save();
    }

    return conversation;
  }

  // Get user's conversations
  static async getUserConversations(
    userId,
    { limit = 50, beforeTimestamp, beforeId } = {}
  ) {
    // Convert limit to a number and ensure it has a maximum value
    limit = Math.min(Number(limit), 100); // Giới hạn tối đa là 100

    // Build query conditions
    const query = {
      "participants.user": userId,
      "participants.deletedBy": { $ne: true }, // Loại bỏ các cuộc trò chuyện đã xóa
      isDeleted: { $ne: true }, // Loại bỏ các cuộc trò chuyện đã xóa
    };

    if (beforeTimestamp) {
      query.updatedAt = { $lt: new Date(beforeTimestamp) };
    }

    if (beforeId) {
      query._id = { $lt: beforeId };
    }

    // Fetch conversations with conditions and pagination
    const conversations = await Conversation.find(query)
      .populate("participants.user", "username avatar status")
      .populate("lastMessage")
      .sort({ updatedAt: -1 })
      .limit(limit);

    // Map conversations to the desired format
    const formattedConversations = conversations.map((conversation) => {
      const userParticipant = conversation.participants.find(
        (p) => p.user._id.toString() === userId.toString()
      );

      return {
        conversationId: conversation._id,
        type: conversation.type,
        name: conversation.type === "group" ? conversation.name : null,
        avatarUrl:
          conversation.type === "group"
            ? conversation.avatar
            : conversation.participants.find(
                (p) => p.user._id.toString() !== userId.toString()
              )?.user.avatar,
        lastMessage: conversation.lastMessage
          ? {
              messageId: conversation.lastMessage._id,
              content: conversation.lastMessage.content,
              timestamp: conversation.lastMessage.createdAt,
            }
          : null,
        unreadCount: userParticipant?.unreadCount || 0,
        isMuted: userParticipant?.isMuted || false,
        isArchived: userParticipant?.isArchived || false,
      };
    });

    // Check if there are more conversations
    const hasMore = conversations.length === limit;

    return {
      conversations: formattedConversations,
      hasMore,
    };
  }

  // Add participant to group
  static async addParticipant(conversationId, userId, newParticipantId) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation || conversation.type !== "group") {
      throw { message: "Cuộc hội thoại nhóm không tồn tại" };
    }

    // Check if user is admin
    const participant = conversation.participants.find(
      (p) => p.user.toString() === userId.toString()
    );

    if (!participant || participant.role !== "admin") {
      throw { message: "Chỉ admin mới có thể thêm người dùng" };
    }

    // Check if user is already in the group
    if (
      conversation.participants.some(
        (p) => p.user.toString() === newParticipantId.toString()
      )
    ) {
      throw { message: "Người dùng đã nằm trong nhóm" };
    }

    const newUser = await User.findById(newParticipantId).select(
      "username avatar"
    );
    if (!newUser) {
      throw { message: "Người dùng không tồn tại" };
    }

    conversation.participants.push({ user: newParticipantId });
    await conversation.save();

    await RedisManager.addConversationParticipant(
      conversationId,
      newParticipantId
    );

    const users = {
      avatarUrl: newUser.avatar,
      name: newUser.username,
    };

    await RedisManager.addConversationParticipant(
      conversationId,
      newParticipantId,
      {
        avatarUrl: newUser.avatar,
        name: newUser.username,
      }
    );
    console.log(`Member added to conversation ${conversationId}:`, users);
  }

  // Remove participant from group
  static async removeParticipant(conversationId, userId, participantId) {
    const conversation = await Conversation.findById(conversationId);
    if (!conversation || conversation.type !== "group") {
      throw { message: "Cuộc hội thoại nhóm không tồn tại", statusCode: 404 };
    }

    // Check if user is admin
    const participant = conversation.participants.find(
      (p) => p.user.toString() === userId.toString()
    );
    if (!participant || participant.role !== "admin") {
      throw { message: "Chỉ admin mới có thể xóa người dùng", statusCode: 403 };
    }

    // Check if participant exists
    const user = await User.findById(participantId);
    if (!user) {
      throw { message: "Người dùng không tồn tại", statusCode: 404 };
    }

    // Check if the participant to be removed exists in the group
    const targetParticipant = conversation.participants.find(
      (p) => p.user.toString() === participantId.toString()
    );
    if (!targetParticipant) {
      throw { message: "Người dùng không tồn tại trong nhóm", statusCode: 400 };
    }

    // Cannot remove the last admin
    const adminCount = conversation.participants.filter(
      (p) => p.role === "admin"
    ).length;
    if (targetParticipant.role === "admin" && adminCount === 1) {
      throw { message: "Không thể xóa admin cuối cùng", statusCode: 400 };
    }

    // Remove participant
    conversation.participants = conversation.participants.filter(
      (p) => p.user.toString() !== participantId.toString()
    );
    await conversation.save();

    // Đồng bộ với Redis
    const redisSuccess = await RedisManager.removeConversationParticipant(
      conversationId,
      participantId
    );
    if (!redisSuccess) {
      throw { message: "Lỗi đồng bộ Redis", statusCode: 500 };
    }
  }
  // Leave conversation
  static async leaveConversation(conversationId, userId) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw { message: "Cuộc hội thoại không tồn tại" };
    }

    if (conversation.type === "private") {
      throw { message: "Không thể rời khỏi cuộc hội thoại riêng tư" };
    }

    // Check if user is the last admin
    const isAdmin =
      conversation.participants.find(
        (p) => p.user.toString() === userId.toString()
      )?.role === "admin";

    if (isAdmin) {
      const adminCount = conversation.participants.filter(
        (p) => p.role === "admin"
      ).length;
      if (adminCount === 1) {
        // Promote another member to admin before leaving
        const newAdmin = conversation.participants.find(
          (p) => p.role !== "admin" && p.user.toString() !== userId.toString()
        );

        if (newAdmin) {
          newAdmin.role = "admin";
        } else {
          throw { message: "Không thể rời khỏi nhóm là admin cuối cùng" };
        }
      }
    }

    conversation.participants = conversation.participants.filter(
      (p) => p.user.toString() !== userId.toString()
    );

    if (conversation.participants.length === 0) {
      await conversation.remove();
    } else {
      await conversation.save();
    }
  }

  static async deleteConversation(conversationId, userId) {
    if (!conversationId || !userId) {
      throw {
        message: "conversationId và userId là bắt buộc",
        statusCode: 400,
      };
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw { message: "Cuộc trò chuyện không tồn tại", statusCode: 404 };
    }

    const participant = conversation.participants.find(
      (p) => p.user && p.user.toString() === userId.toString()
    );
    if (!participant) {
      throw {
        message: "Bạn không phải thành viên của cuộc trò chuyện",
        statusCode: 403,
      };
    }

    if (conversation.type === "group") {
      if (participant.role === "admin") {
        // Admin: Đánh dấu nhóm là đã xóa
        const participantIds = conversation.participants
          .filter((p) => p.user)
          .map((p) => p.user.toString());

        conversation.isDeleted = true;
        conversation.deletedAt = new Date();
        conversation.updatedAt = new Date();

        const session = await Conversation.startSession();
        try {
          session.startTransaction();
          await conversation.save({ session });
          await RedisManager.deleteConversationData(
            conversationId.toString(),
            participantIds
          );
          await RedisManager.publishConversationDeleted({
            conversationId: conversationId.toString(),
            participantIds,
          });
          await session.commitTransaction();
        } catch (error) {
          await session.abortTransaction();
          throw error;
        } finally {
          session.endSession();
        }
      } else {
        // Không phải admin: Đánh dấu deletedBy
        participant.deletedBy = true;
        conversation.updatedAt = new Date();
        await conversation.save();

        // Thông báo chỉ cho người dùng
        await RedisManager.publishConversationDeleted({
          conversationId: conversationId.toString(),
          participantIds: [userId.toString()],
        });
      }
    } else {
      // Private chat: Không thay đổi
      participant.deletedBy = true;
      conversation.updatedAt = new Date();
      const allDeleted = conversation.participants.every((p) => p.deletedBy);
      if (allDeleted) {
        const participantIds = conversation.participants
          .filter((p) => p.user)
          .map((p) => p.user.toString());
        conversation.isDeleted = true;
        conversation.deletedAt = new Date();
        await conversation.save();
        await RedisManager.deleteConversationData(
          conversationId.toString(),
          participantIds
        );
      } else {
        await conversation.save();
      }

      await RedisManager.publishConversationDeleted({
        conversationId: conversationId.toString(),
        participantIds: [userId.toString()],
      });
    }

    return true;
  }
}

module.exports = ConversationService;
