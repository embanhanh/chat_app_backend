const multer = require("multer");
const path = require("path");

// Configure multer for handling file uploads
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  // Allow images, videos and audio files
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "video/mp4",
    "video/mpeg",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

module.exports = upload;
