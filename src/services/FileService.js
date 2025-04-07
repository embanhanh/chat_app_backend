const multer = require("multer");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const sharp = require("sharp");
const crypto = require("crypto");
const { s3Config } = require("../config/s3");

class FileService {
  constructor() {
    this.s3Client = new S3Client(s3Config);
    this.bucketName = process.env.AWS_BUCKET_NAME;
    this.allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "video/mp4",
      "application/pdf",
    ];
    this.maxFileSize = 10 * 1024 * 1024; // 10MB
  }

  // Cấu hình multer cho memory storage
  getUploadMiddleware() {
    return multer({
      storage: multer.memoryStorage(),
      fileFilter: this.fileFilter.bind(this),
      limits: {
        fileSize: this.maxFileSize,
      },
    });
  }

  // Filter file
  fileFilter(req, file, cb) {
    if (this.allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Loại file không được hỗ trợ"), false);
    }
  }

  // Upload file lên S3
  async uploadToS3(file, folder = "") {
    try {
      let fileBuffer = file.buffer;
      let contentType = file.mimetype;
      let key = `${folder}/${crypto
        .randomBytes(16)
        .toString("hex")}${path.extname(file.originalname)}`;

      // Nén ảnh nếu là file ảnh
      if (file.mimetype.startsWith("image/")) {
        fileBuffer = await sharp(file.buffer)
          .resize(800, 800, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 80 })
          .toBuffer();
        contentType = "image/jpeg";
        key = key.replace(/\.[^/.]+$/, ".jpg");
      }

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      });

      await this.s3Client.send(command);

      return {
        key,
        url: `https://${this.bucketName}.s3.amazonaws.com/${key}`,
        contentType,
        size: fileBuffer.length,
      };
    } catch (error) {
      console.error("Error uploading to S3:", error);
      throw error;
    }
  }

  // Xóa file từ S3
  async deleteFromS3(key) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      console.error("Error deleting from S3:", error);
      return false;
    }
  }

  // Lấy thông tin file từ S3
  async getFileInfo(key) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      return {
        size: response.ContentLength,
        contentType: response.ContentType,
        lastModified: response.LastModified,
        url: `https://${this.bucketName}.s3.amazonaws.com/${key}`,
      };
    } catch (error) {
      console.error("Error getting file info from S3:", error);
      return null;
    }
  }

  // Tạo signed URL cho file
  async getSignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Expires: expiresIn,
      });

      return await getSignedUrl(this.s3Client, command);
    } catch (error) {
      console.error("Error generating signed URL:", error);
      throw error;
    }
  }
}

module.exports = new FileService();
