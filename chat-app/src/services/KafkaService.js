const { Kafka } = require("kafkajs");
const RedisManager = require("./RedisManager");

class KafkaService {
  constructor() {
    this.kafka = new Kafka({
      clientId: "chat-app",
      brokers: ["kafka:9092"],
      retry: {
        initialRetryTime: 1000,
        retries: 10,
      },
      connectionTimeout: 10000,
    });

    this.isInitialized = false;
    this.reconnectTimer = null;
    this.topicName = "chat-messages";
    this.processedMessages = new Set(); // Track processed messages
  }

  setIO(io) {
    this.io = io;
  }

  async waitForKafka(retries = 30, interval = 1000) {
    const admin = this.kafka.admin();

    for (let i = 0; i < retries; i++) {
      try {
        await admin.connect();
        console.log("Successfully connected to Kafka broker");
        await admin.disconnect();
        return true;
      } catch (error) {
        console.log(`Waiting for Kafka... Attempt ${i + 1}/${retries}`);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
    throw new Error("Failed to connect to Kafka after multiple retries");
  }

  async ensureTopicExists() {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      const topics = await admin.listTopics();

      if (!topics.includes(this.topicName)) {
        await admin.createTopics({
          validateOnly: false,
          waitForLeaders: true,
          timeout: 5000,
          topics: [
            {
              topic: this.topicName,
              numPartitions: 3,
              replicationFactor: 1,
            },
          ],
        });
        console.log(`Created Kafka topic: ${this.topicName}`);
      } else {
        console.log(`Kafka topic ${this.topicName} already exists`);
      }
    } finally {
      await admin.disconnect();
    }
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      await this.waitForKafka();

      this.producer = this.kafka.producer({
        allowAutoTopicCreation: true,
        idempotent: true,
      });

      this.consumer = this.kafka.consumer({
        groupId: `chat-app-group-${Date.now()}`, // Unique consumer group
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
      });

      await this.ensureTopicExists();
      await this.producer.connect();
      await this.consumer.connect();

      await this.consumer.subscribe({
        topic: this.topicName,
        fromBeginning: false,
      });

      await this.consumer.run({
        autoCommit: true,
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const messageData = JSON.parse(message.value.toString());
            const messageId = messageData.message._id;

            // Skip if message already processed
            if (this.processedMessages.has(messageId)) {
              return;
            }

            // Add to processed set and remove after 5 seconds
            this.processedMessages.add(messageId);
            setTimeout(() => {
              this.processedMessages.delete(messageId);
            }, 5000);

            await this.handleIncomingMessage(messageData);
          } catch (error) {
            console.error("Error processing Kafka message:", error);
          }
        },
      });

      this.producer.on("producer.disconnect", () => {
        console.log("Producer disconnected. Attempting to reconnect...");
        this.handleReconnect();
      });

      this.consumer.on("consumer.disconnect", () => {
        console.log("Consumer disconnected. Attempting to reconnect...");
        this.handleReconnect();
      });

      this.isInitialized = true;
      console.log("✅ Kafka service initialized successfully");
    } catch (error) {
      console.error("Failed to initialize Kafka service:", error);
      throw error;
    }
  }

  async handleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      try {
        if (this.producer) {
          await this.producer.connect();
        }
        if (this.consumer) {
          await this.consumer.connect();
        }
        this.reconnectTimer = null;
        console.log("Reconnected to Kafka successfully");
      } catch (error) {
        console.error("Failed to reconnect to Kafka:", error);
        await this.handleReconnect();
      }
    }, 5000);
  }

  async sendMessage(messageData) {
    try {
      if (!this.isInitialized || !this.producer) {
        console.error("KafkaService not initialized or producer not available");
        throw new Error("KafkaService not properly initialized");
      }

      // console.log("Preparing to send message to Kafka:", {
      //   topic: this.topicName,
      //   messageData: {
      //     conversationId: messageData.conversationId,
      //     messageId: messageData.message._id,
      //     recipientIds: messageData.recipientIds,
      //   },
      // });

      // Send message once through Kafka
      const result = await this.producer.send({
        topic: this.topicName,
        messages: [
          {
            key: messageData.conversationId,
            value: JSON.stringify(messageData),
          },
        ],
      });

      console.log("Message sent to Kafka successfully:", {
        topic: result[0].topicName,
        partition: result[0].partition,
        offset: result[0].baseOffset,
      });
      return true;
    } catch (error) {
      console.error("Error sending message to Kafka:", {
        error: error.message,
        stack: error.stack,
        messageData: {
          conversationId: messageData.conversationId,
          messageId: messageData.message._id,
        },
      });
      if (error.code === "ERR_STREAM_WRITE_AFTER_END") {
        console.log("Attempting to reconnect Kafka producer...");
        await this.handleReconnect();
      }
      throw error;
    }
  }

  async handleIncomingMessage(messageData) {
    try {
      if (!this.io) {
        console.error("Socket.IO instance not initialized in KafkaService");
        throw new Error("Socket.IO instance not initialized in KafkaService");
      }

      const { message, conversationId, recipientIds } = messageData;
      if (!message || !conversationId || !recipientIds) {
        console.error("Invalid message data received from Kafka:", messageData);
        throw new Error("Invalid message data received from Kafka");
      }

      // console.log("Processing Kafka message:", {
      //   conversationId,
      //   recipientIds,
      //   messageId: message._id,
      //   senderId: message.sender._id,
      //   content: message.content,
      // });

      // Emit to conversation room first
      this.io.to(`conversation:${conversationId}`).emit("new_message", {
        message,
        conversationId,
      });
      // console.log(`Emitted to conversation room: conversation:${conversationId}`);

      // Get all participants including sender
      const allParticipants = [
        ...new Set([...recipientIds, message.sender._id]),
      ];
      console.log("All participants:", allParticipants);

      // Then emit to individual sockets
      for (const participantId of allParticipants) {
        const socketIds = await RedisManager.getUserSockets(participantId);
        // console.log(`Found socket IDs for participant ${participantId}:`, socketIds);

        if (socketIds && socketIds.length > 0) {
          socketIds.forEach((socketId) => {
            if (socketId) {
              this.io.to(socketId).emit("new_message", {
                message,
                conversationId,
              });
              // console.log(`Emitted to socket ${socketId} for user ${participantId}`);
            }
          });
        } else {
          console.log(`No active sockets found for user ${participantId}`);
        }
      }
    } catch (error) {
      console.error("Error handling incoming Kafka message:", {
        error: error.message,
        stack: error.stack,
        messageData: {
          conversationId: messageData.conversationId,
          messageId: messageData.message._id,
        },
      });
    }
  }

  async disconnect() {
    try {
      if (this.producer) {
        await this.producer.disconnect();
      }
      if (this.consumer) {
        await this.consumer.disconnect();
      }
      this.isInitialized = false;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.processedMessages.clear();
      console.log("Kafka service disconnected successfully");
    } catch (error) {
      console.error("Error disconnecting Kafka service:", error);
    }
  }
}

// Export singleton instance
const kafkaService = new KafkaService();
module.exports = kafkaService;
