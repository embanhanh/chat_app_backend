const fs = require('fs');
const path = require('path');

// Cache danh sách token để không phải đọc file nhiều lần
let tokensList = null;
let tokenIndex = 0;

module.exports = {
    // Hàm đọc danh sách token từ file JSON
    loadTokens: function () {
        if (tokensList !== null) {
            return tokensList;
        }

        try {
            const tokensFile = path.join(__dirname, 'tokens_only.json');
            const rawData = fs.readFileSync(tokensFile, 'utf8');
            tokensList = JSON.parse(rawData);
            console.log(`Đã tải ${tokensList.length} token từ file.`);
            return tokensList;
        } catch (error) {
            console.error('Lỗi khi đọc file token:', error);
            // Trả về một token giả nếu không thể đọc file
            return ['dummy-token-for-testing'];
        }
    },

    // Hàm lấy một token từ danh sách
    getNextToken: function () {
        const tokens = this.loadTokens();
        if (tokens.length === 0) {
            return 'no-token-available';
        }

        // Lấy token tiếp theo và quay vòng nếu hết
        const token = tokens[tokenIndex];
        tokenIndex = (tokenIndex + 1) % tokens.length;
        return token;
    },

    // Hàm được gọi trong kịch bản để tải token
    loadToken: function (userContext, events, done) {
        userContext.vars.token = this.getNextToken();

        // Tạo conversationId nếu chưa có
        if (!userContext.vars.conversationId) {
            userContext.vars.conversationId = `conv-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        }

        console.log(`Sử dụng token: ${userContext.vars.token.substring(0, 15)}... cho conversationId: ${userContext.vars.conversationId}`);
        return done();
    },

    sendMessage: function (userContext, events, done) {
        const cidPrefix = `[CID:`;
        const cidSuffix = `]`;
        const conversationId = userContext.vars.conversationId;

        // Tạo ID tin nhắn duy nhất
        const clientMsgId = `vu${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const content = `Msg with token=${userContext.vars.token.substring(0, 15)}... ${cidPrefix}${clientMsgId}${cidSuffix}`;

        // Gửi event send_message
        userContext.socket.emit('send_message', {
            data: { conversationId, content }
        });

        return done();
    }
};