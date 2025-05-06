const WebRTCService = {
  // Lưu trữ các kết nối WebRTC đang hoạt động
  activeConnections: new Map(),

  // Import Conversation model
  Conversation: require('./models/Conversation'),

  // Cấu hình ICE servers (STUN/TURN)
  iceServers: {
    iceServers: [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302'
        ]
      },
      // Thêm TURN server configuration ở đây
      {
        urls: process.env.TURN_SERVER_URL,
        username: process.env.TURN_SERVER_USERNAME,
        credential: process.env.TURN_SERVER_CREDENTIAL
      }
    ]
  },

  // Khởi tạo WebRTC handlers
  initializeWebRTCHandlers: function (io, socket) {
    if (!socket) {
      console.error("Socket is undefined in initializeWebRTCHandlers");
      return;
    }

    console.log(`Initializing WebRTC handlers for user: ${socket.userId}`);

    // Xử lý sự kiện gọi người dùng
    socket.on("call_user", async (data) => {
      try {
        console.log('📞 Call request:', {
          from: socket.userId,
          conversationId: data.conversationId,
          type: data.type,
          timestamp: new Date().toISOString()
        });

        // Kiểm tra conversation
        const conversation = await this.Conversation.findById(data.conversationId);
        if (!conversation) {
          throw new Error('Cuộc trò chuyện không tồn tại');
        }

        // Kiểm tra user có trong conversation không
        const isParticipant = conversation.participants.some(
          p => p.user.toString() === socket.userId.toString()
        );
        if (!isParticipant) {
          throw new Error('Bạn không phải thành viên của cuộc trò chuyện này');
        }

        // Lấy danh sách người tham gia (trừ người gọi)
        const participants = conversation.participants
          .filter(p => p.user.toString() !== socket.userId.toString())
          .map(p => p.user.toString());

        // Gửi thông báo cuộc gọi đến tất cả thành viên
        for (const targetUserId of participants) {
          const targetSocket = await this.getUserSocket(io, targetUserId);
          if (targetSocket) {
            console.log('📨 Emitting incoming_call to:', targetUserId);
            targetSocket.emit('incoming_call', {
              from: socket.userId,
              fromUsername: socket.username || socket.userId,
              type: data.type,
              conversationId: data.conversationId
            });
          } else {
            console.log(`⚠️ Cannot send call notification to user ${targetUserId}: User is offline`);
          }
        }

        // Khởi tạo kết nối WebRTC cho từng người tham gia
        participants.forEach(targetUserId => {
          this.initializeWebRTCConnection(socket.userId, targetUserId);
        });

        console.log('✅ WebRTC connections initialized for all participants');
      } catch (error) {
        console.error('Error handling call request:', error);
        socket.emit('call_error', {
          message: error.message || 'Không thể thực hiện cuộc gọi'
        });
      }
    });

    // Xử lý khi user trả lời cuộc gọi
    socket.on('call_response', ({ targetUserId, accepted, reason }) => {
      try {
        console.log(`User ${socket.userId} ${accepted ? 'accepted' : 'rejected'} call from ${targetUserId}`);

        if (accepted) {
          // Thông báo chấp nhận cuộc gọi
          io.to(`user:${targetUserId}`).emit('call_accepted', {
            from: socket.userId,
            username: socket.username
          });
        } else {
          // Thông báo từ chối cuộc gọi
          io.to(`user:${targetUserId}`).emit('call_rejected', {
            from: socket.userId,
            reason
          });
        }
      } catch (error) {
        console.error('Error in call_response:', error);
        socket.emit('call_error', {
          message: 'Lỗi xử lý phản hồi cuộc gọi'
        });
      }
    });

    // Xử lý trao đổi SDP
    socket.on('offer', async (data) => {
      try {
        console.log(`Sending offer from ${socket.userId} to ${data.targetUserId}`);
        const targetSocket = await this.getUserSocket(io, data.targetUserId);
        
        if (!targetSocket || !targetSocket.connected) {
          console.log(`⚠️ Cannot send offer to user ${data.targetUserId}: User is offline or socket invalid`);
          socket.emit('call_error', {
            message: 'Người dùng không trực tuyến'
          });
          return;
        }

        targetSocket.emit('offer', {
          offer: data.offer,
          from: socket.userId
        });
      } catch (error) {
        console.error('Error in handling offer:', error);
        socket.emit('call_error', {
          message: 'Lỗi xử lý offer: ' + error.message
        });
      }
    });

    socket.on('answer', async ({ answer, targetUserId }) => {
      try {
        console.log(`Sending answer from ${socket.userId} to ${targetUserId}`);
        const targetSocket = await this.getUserSocket(io, targetUserId);
        
        if (!targetSocket || !targetSocket.connected) {
          console.log(`⚠️ Cannot send answer to user ${targetUserId}: User is offline or socket invalid`);
          socket.emit('call_error', {
            message: 'Người dùng không trực tuyến'
          });
          return;
        }

        targetSocket.emit('answer', {
          answer,
          from: socket.userId
        });
      } catch (error) {
        console.error('Error in handling answer:', error);
        socket.emit('call_error', {
          message: 'Lỗi xử lý answer: ' + error.message
        });
      }
    });

    // Xử lý trao đổi ICE candidates
    socket.on('ice_candidate', async ({ candidate, targetUserId }) => {
      try {
        console.log(`Sending ICE candidate from ${socket.userId} to ${targetUserId}`);
        const targetSocket = await this.getUserSocket(io, targetUserId);
        
        if (!targetSocket || !targetSocket.connected) {
          console.log(`⚠️ Cannot send ICE candidate to user ${targetUserId}: User is offline or socket invalid`);
          socket.emit('call_error', {
            message: 'Người dùng không trực tuyến'
          });
          return;
        }

        targetSocket.emit('ice_candidate', {
          candidate,
          from: socket.userId
        });
      } catch (error) {
        console.error('Error in handling ICE candidate:', error);
        socket.emit('call_error', {
          message: 'Lỗi xử lý ICE candidate: ' + error.message
        });
      }
    });

    // Xử lý kết thúc cuộc gọi
    socket.on('end_call', ({ targetUserId }) => {
      try {
        console.log(`Call ended by ${socket.userId} to ${targetUserId}`);
        
        // Thông báo cho người được gọi
        io.to(`user:${targetUserId}`).emit('participant_left', {
          userId: socket.userId
        });

        // Thông báo cho người gọi
        socket.emit('participant_left', {
          userId: targetUserId
        });

        // Dọn dẹp kết nối
        this.cleanupConnection(socket.userId, targetUserId);
      } catch (error) {
        console.error('Error in ending call:', error);
        socket.emit('call_error', {
          message: 'Lỗi kết thúc cuộc gọi: ' + error.message
        });
      }
    });

    // Xử lý ngắt kết nối
    socket.on('disconnect', () => {
      try {
        console.log(`User disconnected: ${socket.userId}`);
        
        // Thông báo cho tất cả các phòng mà user này đang tham gia
        socket.rooms.forEach(room => {
          if (room !== socket.id && room !== `user:${socket.userId}`) {
            io.to(room).emit('participant_left', {
              userId: socket.userId
            });
          }
        });

        // Dọn dẹp tất cả kết nối của user này
        this.cleanupAllConnections(socket.userId);
      } catch (error) {
        console.error('Error handling disconnect:', error);
      }
    });

    socket.on('notify_existing_participants', async ({ targetUserId, participants }) => {
        try {
            console.log('📢 Notifying new participant about existing participants:', {
                targetUserId,
                participants
            });

            const targetSocket = await this.getUserSocket(io, targetUserId);
            if (targetSocket) {
                targetSocket.emit('existing_participants', { participants });

                // Thông báo cho tất cả người tham gia hiện có về người mới
                participants.forEach(async (participantId) => {
                    const participantSocket = await this.getUserSocket(io, participantId);
                    if (participantSocket) {
                        participantSocket.emit('new_participant', { userId: targetUserId });
                    }
                });
            }
        } catch (error) {
            console.error('Error notifying about existing participants:', error);
        }
    });

    // Xử lý thay đổi trạng thái audio
    socket.on('audio_state_changed', async (data) => {
      try {
        console.log(`Audio state changed for user ${socket.userId}:`, data);
        
        // Thông báo cho tất cả người tham gia trong cuộc gọi
        socket.rooms.forEach(async (room) => {
          if (room !== socket.id && room !== `user:${socket.userId}`) {
            io.to(room).emit('audio_state_changed', {
              userId: socket.userId,
              isMuted: data.isMuted
            });
          }
        });
      } catch (error) {
        console.error('Error handling audio state change:', error);
      }
    });
  },

  // Helper function để lấy socket của một user
  async getUserSocket(io, userId) {
    try {
      // Lấy tất cả sockets trong room của user
      const sockets = await io.in(`user:${userId}`).fetchSockets();

      if (!sockets || sockets.length === 0) {
        console.log(`No active socket found for user ${userId}`);
        return null;
      }

      // Lấy socket đầu tiên và kiểm tra kết nối
      const socket = sockets[0];
      
      if (!socket || typeof socket.emit !== 'function' || !socket.connected) {
        console.error(`Invalid or disconnected socket for user ${userId}`);
        return null;
      }

      console.log(`Found valid socket for user ${userId}`);
      return socket;
    } catch (error) {
      console.error('Error getting user socket:', error);
      return null;
    }
  },

  // Khởi tạo kết nối WebRTC mới
  initializeWebRTCConnection(userId1, userId2) {
    const connectionId = this.getConnectionId(userId1, userId2);
    this.activeConnections.set(connectionId, {
      users: [userId1, userId2],
      startTime: new Date()
    });
    console.log(`WebRTC connection initialized between ${userId1} and ${userId2}`);
  },

  // Dọn dẹp kết nối khi kết thúc
  cleanupConnection(userId1, userId2) {
    const connectionId = this.getConnectionId(userId1, userId2);
    this.activeConnections.delete(connectionId);
    console.log(`Cleaned up connection between ${userId1} and ${userId2}`);
  },

  // Dọn dẹp tất cả kết nối của một user
  cleanupAllConnections(userId) {
    for (const [connectionId, connection] of this.activeConnections) {
      if (connection.users.includes(userId)) {
        this.activeConnections.delete(connectionId);
        console.log(`Cleaned up connection ${connectionId} for user ${userId}`);
      }
    }
  },

  // Helper để tạo unique connection ID
  getConnectionId(userId1, userId2) {
    return [userId1, userId2].sort().join('-');
  }
};

module.exports = WebRTCService;