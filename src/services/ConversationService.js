const Conversation = require("../models/Conversation");
const User = require("../models/User");
const FileService = require("./FileService");

class ConversationService {
  // Get conversation by id
  static async getConversationById(conversationId) {
    const conversation = await Conversation.findById(conversationId)
      .populate("participants.user", "username avatar status")
      .populate("lastMessage");

    if (!conversation) {
      throw { message: "Cuộc hội thoại không tồn tại" };
    }

    return conversation;
  }

  // Create a new private conversation
  static async createPrivateConversation(userId1, userId2) {
    // Check if conversation already exists
    const existingConversation = await Conversation.findOne({
      type: "private",
      "participants.user": { $all: [userId1, userId2] },
    });

    if (existingConversation) {
      return existingConversation;
    }

    // Create new conversation
    const conversation = new Conversation({
      type: "private",
      participants: [{ user: userId1 }, { user: userId2 }],
    });

    await conversation.save();
    return conversation;
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
        return conversation;
      }
    }

    const allParticipants = [creatorId, ...participantIds];

    // Verify all participants exist
    const users = await User.find({ _id: { $in: allParticipants } });
    if (users.length !== allParticipants.length) {
      throw { message: "Một hoặc nhiều người dùng không tồn tại" };
    }

    const conversation = new Conversation({
      type: "group",
      name,
      participants: [
        { user: creatorId, role: "admin" },
        ...participantIds.map((id) => ({ user: id })),
      ],
    });

    await conversation.save();
    return conversation;
  }

  // Update group conversation name
  static async updateGroupConversationName(conversationId, userId, name) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation || conversation.type !== "group") {
      throw { message: "Cuộc hội thoại nhóm không tồn tại" };
    }

    if (
      !conversation.participants.find(
        (p) => p.user.toString() === userId.toString()
      )
    ) {
      throw { message: "Bạn không có quyền sửa tên nhóm" };
    }

    conversation.name = name;
    await conversation.save();
    return conversation;
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
  static async getUserConversations(userId) {
    return Conversation.find({ "participants.user": userId })
      .populate("participants.user", "username avatar status")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });
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

    conversation.participants.push({ user: newParticipantId });
    await conversation.save();
  }

  // Remove participant from group
  static async removeParticipant(conversationId, userId, participantId) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation || conversation.type !== "group") {
      throw { message: "Cuộc hội thoại nhóm không tồn tại" };
    }

    // Check if user is admin
    const participant = conversation.participants.find(
      (p) => p.user.toString() === userId.toString()
    );

    if (!participant || participant.role !== "admin") {
      throw { message: "Chỉ admin mới có thể xóa người dùng" };
    }

    // Cannot remove the last admin
    const adminCount = conversation.participants.filter(
      (p) => p.role === "admin"
    ).length;
    const targetParticipant = conversation.participants.find(
      (p) => p.user.toString() === participantId.toString()
    );

    if (targetParticipant?.role === "admin" && adminCount === 1) {
      throw { message: "Không thể xóa admin cuối cùng" };
    }

    conversation.participants = conversation.participants.filter(
      (p) => p.user.toString() !== participantId.toString()
    );

    await conversation.save();
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
}

module.exports = ConversationService;
