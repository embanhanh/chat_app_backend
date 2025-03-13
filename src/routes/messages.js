require("dotenv").config();
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const upload = require("../middlewares/upload");
const MessageService = require("../services/MessageService");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION });

// Get messages for a conversation
router.get("/:conversationId", auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const messages = await MessageService.getMessages(
      req.params.conversationId,
      parseInt(page)
    );
    res.json(messages);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send text message
router.post("/:conversationId", auth, async (req, res) => {
  try {
    const { content } = req.body;
    const message = await MessageService.sendMessage(
      req.user._id,
      req.params.conversationId,
      { content }
    );
    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Send media message
router.post(
  "/:conversationId/media",
  auth,
  upload.single("media"),
  async (req, res) => {
    try {
      const file = req.file;
      const key = `messages/${req.params.conversationId}/${Date.now()}-${
        file.originalname
      }`;

      const uploadParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: "public-read",
      };

      const command = new PutObjectCommand(uploadParams);
      const result = await s3.send(command);

      const message = await MessageService.sendMessage(
        req.user._id,
        req.params.conversationId,
        {
          content: file.originalname,
          contentType: file.mimetype.startsWith("image/")
            ? "image"
            : file.mimetype.startsWith("video/")
            ? "video"
            : file.mimetype.startsWith("audio/")
            ? "audio"
            : "file",
          mediaUrl: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
        }
      );

      res.status(201).json(message);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

// Mark messages as read
router.post("/:conversationId/read", auth, async (req, res) => {
  try {
    await MessageService.markAsRead(req.user._id, req.params.conversationId);
    res.json({ message: "Messages marked as read" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete message
router.delete("/:messageId", auth, async (req, res) => {
  try {
    await MessageService.deleteMessage(req.params.messageId, req.user._id);
    res.json({ message: "Message deleted successfully" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
