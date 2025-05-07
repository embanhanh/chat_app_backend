const express = require("express");
const router = express.Router();
const FileService = require("../services/FileService");
const auth = require("../middlewares/auth");
const path = require("path");

// Upload file
router.post(
  "/upload",
  auth,
  FileService.getUploadMiddleware().single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Không có file được tải lên" });
      }

      const fileInfo = FileService.getFileInfo(req.file.path);

      // Nén ảnh nếu là file ảnh
      if (req.file.mimetype.startsWith("image/")) {
        const compressedPath = req.file.path.replace(
          /\.[^/.]+$/,
          "_compressed.jpg"
        );
        await FileService.compressImage(req.file.path, compressedPath);
        // Xóa file gốc sau khi nén
        await FileService.deleteFile(req.file.path);
        req.file.path = compressedPath;
      }

      res.json({
        success: true,
        file: {
          path: req.file.path,
          filename: req.file.filename,
          mimetype: req.file.mimetype,
          size: fileInfo.size,
          type: fileInfo.type,
        },
      });
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ message: "Lỗi khi tải file lên" });
    }
  }
);

// Xóa file
router.delete("/:filename", auth, async (req, res) => {
  try {
    const filePath = path.join(FileService.uploadDir, req.params.filename);
    const success = await FileService.deleteFile(filePath);

    if (success) {
      res.json({ message: "File đã được xóa" });
    } else {
      res.status(404).json({ message: "Không tìm thấy file" });
    }
  } catch (error) {
    console.error("Error deleting file:", error);
    res.status(500).json({ message: "Lỗi khi xóa file" });
  }
});

// Lấy thông tin file
router.get("/:filename", auth, async (req, res) => {
  try {
    const filePath = path.join(FileService.uploadDir, req.params.filename);
    const fileInfo = FileService.getFileInfo(filePath);

    if (fileInfo) {
      res.json(fileInfo);
    } else {
      res.status(404).json({ message: "Không tìm thấy file" });
    }
  } catch (error) {
    console.error("Error getting file info:", error);
    res.status(500).json({ message: "Lỗi khi lấy thông tin file" });
  }
});

module.exports = router;
