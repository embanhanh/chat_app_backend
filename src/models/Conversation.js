const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["private", "group"],
      required: true,
    },
    name: {
      type: String,
      trim: true,
      required: function () {
        return this.type === "group";
      },
    },
    participants: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        role: {
          type: String,
          enum: ["admin", "member"],
          default: "member",
        },
        lastRead: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
    avatar: {
      type: String,
      default: "",
    },
    unreadCount: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Ensure at least 2 participants
conversationSchema.pre("save", function (next) {
  if (this.participants.length < 2) {
    next(new Error("Conversation must have at least 2 participants"));
  } else {
    next();
  }
});

// Index for faster queries
conversationSchema.index({ "participants.user": 1 });
conversationSchema.index({ updatedAt: -1 });

// Method to get conversation details
conversationSchema.methods.getDetails = function (userId) {
  const conversation = this.toObject();

  if (conversation.type === "private") {
    const otherParticipant = conversation.participants.find(
      (p) => p.user.toString() !== userId.toString()
    );
    if (otherParticipant) {
      conversation.name = otherParticipant.user.username;
      conversation.avatar = otherParticipant.user.avatar;
    }
  }

  return conversation;
};

const Conversation = mongoose.model("Conversation", conversationSchema);

module.exports = Conversation;
