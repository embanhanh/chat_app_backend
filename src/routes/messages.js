require("dotenv").config();
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const upload = require("../middlewares/upload");
const MessageService = require("../services/MessageService");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION });

// Get messages for a conversation
// [GET] api/messages/:conversationId
router.get("/:conversationId", auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const messages = await MessageService.getMessages(
      req.params.conversationId,
      parseInt(page)
    );
    res.json(messages);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Send text message
// [POST] api/messages/:conversationId
router.post("/:conversationId", auth, async (req, res) => {
  try {
    const { content, replyTo } = req.body;
    const message = await MessageService.sendMessage(
      req.user._id,
      req.params.conversationId,
      { content, replyTo }
    );
    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Send media message (single file) - Giữ lại để tương thích ngược
// [POST] api/messages/:conversationId/media
router.post(
  "/:conversationId/media",
  auth,
  upload.single("media"),
  async (req, res) => {
    try {
      const file = req.file;
      const { content = "" } = req.body;
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
          content: content || "",
          contentType: "media",
          media: [
            {
              filename: file.originalname,
              contentType: file.mimetype.startsWith("image/")
                ? "image"
                : file.mimetype.startsWith("video/")
                ? "video"
                : file.mimetype.startsWith("audio/")
                ? "audio"
                : "file",
              mimeType: file.mimetype,
              size: file.size,
              url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
            },
          ],
        }
      );

      res.status(201).json(message);
    } catch (error) {
      res.status(400).json({ message: error.message });
    }
  }
);

// Send message with media (single or multiple files)
// [POST] api/messages/:conversationId/attachments
router.post(
  "/:conversationId/attachments",
  auth,
  upload.array("attachments", 10), // Cho phép tối đa 10 file
  async (req, res) => {
    try {
      const files = req.files;
      const { content = "" } = req.body;

      if (!files || files.length === 0) {
        return res
          .status(400)
          .json({ message: "Không có file nào được tải lên" });
      }

      // Tải tất cả các file lên S3
      const attachments = await Promise.all(
        files.map(async (file) => {
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
          await s3.send(command);

          return {
            filename: file.originalname,
            contentType: file.mimetype.startsWith("image/")
              ? "image"
              : file.mimetype.startsWith("video/")
              ? "video"
              : file.mimetype.startsWith("audio/")
              ? "audio"
              : "file",
            mimeType: file.mimetype,
            size: file.size,
            url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
          };
        })
      );

      // Tạo tin nhắn với nhiều tệp đính kèm
      const message = await MessageService.sendMessage(
        req.user._id,
        req.params.conversationId,
        {
          content: content || "",
          media: attachments,
        }
      );

      res.status(201).json(message);
    } catch (error) {
      console.error("Error uploading attachments:", error);
      res
        .status(400)
        .json({ message: error.message || "Lỗi khi tải lên tệp đính kèm" });
    }
  }
);

// Mark messages as read
// [POST] api/messages/:conversationId/read
router.post("/:conversationId/read", auth, async (req, res) => {
  try {
    await MessageService.markAsRead(req.user._id, req.params.conversationId);
    res.json({ message: "Messages marked as read" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete message
// [DELETE] api/messages/:messageId
router.delete("/:messageId", auth, async (req, res) => {
  try {
    await MessageService.deleteMessage(req.params.messageId, req.user._id);
    res.json({ message: "Message deleted successfully" });
  } catch (error) {
    if (error.message === "Tin nhắn không tồn tại") {
      res.status(404).json({ message: error.message });
    } else if (error.message === "Không có quyền xóa tin nhắn này") {
      res.status(403).json({ message: error.message });
    } else {
      res.status(400).json({ message: error.message });
    }
  }
});

// Edit message
// [PUT] api/messages/:messageId
router.put("/:messageId", auth, async (req, res) => {
  try {
    const { content } = req.body;
    const message = await MessageService.editMessage(
      req.params.messageId, 
      req.user._id,
      content
    );
    res.json(message);
  } catch (error) {
    if (error.message === "Tin nhắn không tồn tại") {
      res.status(404).json({ message: error.message });
    } else if (error.message === "Không có quyền chỉnh sửa tin nhắn này") {
      res.status(403).json({ message: error.message });
    } else {
      res.status(400).json({ message: error.message });
    }
  }
});

// Reply to a message
// [POST] api/messages/:messageId/reply
router.post("/:messageId/reply", auth, upload.array("attachments", 10), async (req, res) => {
  try {
    const { content } = req.body;
    const files = req.files;
    let messageData = { content };

    // Nếu có files, xử lý upload
    if (files && files.length > 0) {
      const mediaFiles = await Promise.all(
        files.map(async (file) => {
          const key = `messages/replies/${Date.now()}-${file.originalname}`;

          const uploadParams = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
          };

          const command = new PutObjectCommand(uploadParams);
          await s3.send(command);

          return {
            filename: file.originalname,
            contentType: file.mimetype.startsWith("image/")
              ? "image"
              : file.mimetype.startsWith("video/")
              ? "video"
              : file.mimetype.startsWith("audio/")
              ? "audio"
              : "file",
            mimeType: file.mimetype,
            size: file.size,
            url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
          };
        })
      );

      messageData.media = mediaFiles;
      messageData.contentType = "media";
    } else {
      messageData.contentType = "text";
    }

    const message = await MessageService.replyMessage(
      req.user._id,
      req.params.messageId,
      messageData
    );

    res.status(201).json(message);
  } catch (error) {
    console.error("Error replying to message:", error);
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
