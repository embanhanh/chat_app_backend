const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const ConversationService = require("../services/ConversationService");
const upload = require("../middlewares/upload");

// Get user's conversations
// [GET] api/conversations
router.get("/", auth, async (req, res) => {
  try {
    const conversations = await ConversationService.getUserConversations(
      req.user._id
    );
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
// [POST] api/conversations/private/:userId
router.post("/private/:userId", auth, async (req, res) => {
  try {
    const conversation = await ConversationService.createPrivateConversation(
      req.user._id,
      req.params.userId
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
    const { name, participants, conversationId } = req.body;
    const conversation = await ConversationService.createGroupConversation(
      name,
      req.user._id,
      participants,
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
// [POST] api/conversations/:id/participants
router.post("/:id/participants", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    await ConversationService.addParticipant(
      req.params.id,
      req.user._id,
      userId
    );
    res.json({ message: "Participant added successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Remove participant from group
// [DELETE] api/conversations/:id/participants/:userId
router.delete("/:id/participants/:userId", auth, async (req, res) => {
  try {
    await ConversationService.removeParticipant(
      req.params.id,
      req.user._id,
      req.params.userId
    );
    res.json({ message: "Participant removed successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Leave conversation
// [POST] api/conversations/:id/leave
router.post("/:id/leave", auth, async (req, res) => {
  try {
    await ConversationService.leaveConversation(req.params.id, req.user._id);
    res.json({ message: "Left conversation successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
