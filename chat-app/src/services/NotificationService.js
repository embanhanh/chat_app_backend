const admin = require("firebase-admin");
const serviceAccount = require("../../serviceAccountKey.json");

class NotificationService {
  constructor() {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  // Gửi notification đến một thiết bị
  async sendToDevice(deviceToken, title, body, data = {}) {
    try {
      const message = {
        notification: {
          title,
          body,
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
        data,
        token: deviceToken,
      };

      const response = await admin.messaging().send(message);
      return { success: true, response };
    } catch (error) {
      console.error("Error sending notification:", error);
      return { success: false, error: error.message };
    }
  }

  // Gửi notification đến nhiều thiết bị
  async sendToMultipleDevices(deviceTokens, title, body, data = {}) {
    try {
      const message = {
        notification: {
          title,
          body,
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
        data,
        tokens: deviceTokens,
      };

      const response = await admin.messaging().sendMulticast(message);
      return { success: true, response };
    } catch (error) {
      console.error("Error sending multicast notification:", error);
      return { success: false, error: error.message };
    }
  }

  // Gửi notification đến một topic
  async sendToTopic(topic, title, body, data = {}) {
    try {
      const message = {
        notification: {
          title,
          body,
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
        data,
        topic,
      };

      const response = await admin.messaging().send(message);
      return { success: true, response };
    } catch (error) {
      console.error("Error sending topic notification:", error);
      return { success: false, error: error.message };
    }
  }

  // Đăng ký device token cho một topic
  async subscribeToTopic(deviceToken, topic) {
    try {
      await admin.messaging().subscribeToTopic(deviceToken, topic);
      return { success: true };
    } catch (error) {
      console.error("Error subscribing to topic:", error);
      return { success: false, error: error.message };
    }
  }

  // Hủy đăng ký device token khỏi một topic
  async unsubscribeFromTopic(deviceToken, topic) {
    try {
      await admin.messaging().unsubscribeFromTopic(deviceToken, topic);
      return { success: true };
    } catch (error) {
      console.error("Error unsubscribing from topic:", error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new NotificationService();
