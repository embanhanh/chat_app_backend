const WebRTCService = {
  // Lưu trữ các kết nối WebRTC đang hoạt động
  activeConnections: new Map(),

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

  // Khởi tạo WebRTC handlers cho socket
  initializeWebRTCHandlers(socket) {
    console.log('Initializing WebRTC handlers for user:', socket.userId);
    
    // Xử lý khi user bắt đầu cuộc gọi
    socket.on('call_user', async ({ targetUserId, type = 'video' }) => {
        try {
            console.log('📞 Call request:', {
                from: socket.userId,
                to: targetUserId,
                type,
                timestamp: new Date().toISOString()
            });
            
            // Kiểm tra user có online không
            const targetSocket = await this.getUserSocket(targetUserId);
            console.log('🔍 Target socket check:', {
                targetUserId,
                isOnline: !!targetSocket,
                targetSocketId: targetSocket?.id
            });

            if (!targetSocket) {
                console.log('❌ Target user offline:', targetUserId);
                socket.emit('call_error', {
                    message: 'Người dùng không trực tuyến'
                });
                return;
            }

            // Kiểm tra room của người nhận
            const targetRooms = Array.from(await global.io.in(`user:${targetUserId}`).allSockets());
            console.log('🚪 Target user rooms:', {
                targetUserId,
                rooms: targetRooms,
                expectedRoom: `user:${targetUserId}`
            });

            // Gửi thông báo cuộc gọi đến người nhận
            console.log('📨 Emitting incoming_call to:', `user:${targetUserId}`);
            global.io.to(`user:${targetUserId}`).emit('incoming_call', {
                from: socket.userId,
                fromUsername: socket.username || socket.userId,
                type
            });

            // Khởi tạo kết nối WebRTC
            this.initializeWebRTCConnection(socket.userId, targetUserId);
            console.log('✅ WebRTC connection initialized');

        } catch (error) {
            console.error('❌ Error in call_user:', error);
            socket.emit('call_error', {
                message: 'Không thể thực hiện cuộc gọi: ' + error.message
            });
        }
    });
      

    // Xử lý khi user trả lời cuộc gọi
    socket.on('call_response', ({ targetUserId, accepted }) => {
      try {
        console.log(`User ${socket.userId} ${accepted ? 'accepted' : 'rejected'} call from ${targetUserId}`);
        
        if (accepted) {
          // Thông báo chấp nhận cuộc gọi
          global.io.to(`user:${targetUserId}`).emit('call_accepted', {
            from: socket.userId,
            username: socket.username
          });
        } else {
          // Thông báo từ chối cuộc gọi
          global.io.to(`user:${targetUserId}`).emit('call_rejected', {
            from: socket.userId
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
    socket.on('offer', ({ offer, targetUserId }) => {
      try {
        console.log(`Sending offer from ${socket.userId} to ${targetUserId}`);
        global.io.to(`user:${targetUserId}`).emit('offer', {
          offer,
          from: socket.userId
        });
      } catch (error) {
        console.error('Error in handling offer:', error);
      }
    });

    socket.on('answer', ({ answer, targetUserId }) => {
      try {
        console.log(`Sending answer from ${socket.userId} to ${targetUserId}`);
        global.io.to(`user:${targetUserId}`).emit('answer', {
          answer,
          from: socket.userId
        });
      } catch (error) {
        console.error('Error in handling answer:', error);
      }
    });

    // Xử lý trao đổi ICE candidates
    socket.on('ice_candidate', ({ candidate, targetUserId }) => {
      try {
        console.log(`Sending ICE candidate from ${socket.userId} to ${targetUserId}`);
        global.io.to(`user:${targetUserId}`).emit('ice_candidate', {
          candidate,
          from: socket.userId
        });
      } catch (error) {
        console.error('Error in handling ICE candidate:', error);
      }
    });

    // Xử lý kết thúc cuộc gọi
    socket.on('end_call', ({ targetUserId }) => {
      try {
        console.log(`Call ended by ${socket.userId} to ${targetUserId}`);
        global.io.to(`user:${targetUserId}`).emit('call_ended', {
          from: socket.userId
        });
        
        // Dọn dẹp kết nối
        this.cleanupConnection(socket.userId, targetUserId);
      } catch (error) {
        console.error('Error in ending call:', error);
      }
    });

    // Xử lý ngắt kết nối
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.userId}`);
      // Dọn dẹp tất cả kết nối của user này
      this.cleanupAllConnections(socket.userId);
    });
  },

  // Helper function để lấy socket của một user
  async getUserSocket(userId) {
    try {
      const sockets = await global.io.in(`user:${userId}`).allSockets();
      if (!sockets || sockets.size === 0) {
        return false;
      }
      // Lấy socket đầu tiên của user
      const socketId = Array.from(sockets)[0];
      return global.io.sockets.sockets.get(socketId);
    } catch (error) {
      console.error('Error getting user socket:', error);
      return false;
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