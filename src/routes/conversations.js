const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const ConversationService = require("../services/ConversationService");
const upload = require("../middlewares/upload");

// Get user's conversations
// [GET] api/conversations
router.get("/", auth, async (req, res) => {
  try {
    // Lấy query params từ request
    const { limit, beforeTimestamp, beforeId } = req.query;

    // Gọi service với các tham số
    const conversations = await ConversationService.getUserConversations(
      req.user._id,
      {
        limit: limit ? parseInt(limit, 10) : undefined,
        beforeTimestamp,
        beforeId,
      }
    );

    // Trả về kết quả
    res.json(conversations);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get conversation by id
// [GET] api/conversations/:id
router.get("/:id", auth, async (req, res) => {
  try {
    const conversation = await ConversationService.getConversationById(
      req.params.id
    );
    res.json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Create private conversation
// [POST] api/conversations/private
router.post("/private", auth, async (req, res) => {
  try {
    const otherUserId = req.body.otherUserId;
    const conversation = await ConversationService.createPrivateConversation(
      req.user._id,
      otherUserId
    );
    res.status(201).json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Create group conversation
// [POST] api/conversations/group
router.post("/group", auth, async (req, res) => {
  try {
    const { name, members, conversationId } = req.body;
    const conversation = await ConversationService.createGroupConversation(
      name,
      req.user._id,
      members,
      conversationId
    );
    res.status(201).json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update group conversation name
// [PATCH] api/conversations/:id/name
router.patch("/:id/name", auth, async (req, res) => {
  try {
    const { name } = req.body;
    const conversation = await ConversationService.updateGroupConversationName(
      req.params.id,
      req.user._id,
      name
    );
    res.json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update group conversation avatar
// [PATCH] api/conversations/:id/avatar
router.patch("/:id/avatar", auth, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) {
      throw { message: "Không có file được tải lên" };
    }

    const conversation =
      await ConversationService.updateGroupConversationAvatar(
        req.params.id,
        req.user._id,
        req.file
      );
    res.json(conversation);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Add participant to group
// [POST] api/conversations/:conversationId/members
router.post("/:conversationId/members", auth, async (req, res) => {
  try {
    const { userIds } = req.body;
    await ConversationService.addParticipant(
      req.params.conversationId,
      req.user._id,
      userIds
    );
    res.json({ message: "Participant added successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Remove participant from group
// [DELETE] api/conversations/:id/participants/:userId
router.delete("/:conversationId/members/:userId", auth, async (req, res) => {
  try {
    if (req.params.userId === req.user._id) {
      return res.status(400).json({ message: "Cannot remove yourself" });
    }
    
    await ConversationService.removeParticipant(
      req.params.conversationId,
      req.user._id,
      req.params.userId
    );
    res.json({ message: "Participant removed successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Leave conversation
// [DELETE] api/conversations/:conversationId/leave
router.delete("/:conversationId/leave", auth, async (req, res) => {
  try {
    await ConversationService.leaveConversation(req.params.conversationId, req.user._id);
    res.json({ message: "Left conversation successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete conversation
// [DELETE] api/conversations/:conversationId
router.delete("/:conversationId", auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user._id;

    await ConversationService.deleteConversation(conversationId, userId);
    res.status(200).json({ message: "Xóa cuộc trò chuyện thành công" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

module.exports = router;
