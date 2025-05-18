import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter, Rate } from 'k6/metrics';

// --- BEGIN Configuration ---
const SERVER_URL = 'ws://localhost';                        // THAY THẾ: Địa chỉ server của bạn
const CONVERSATION_ID = '6810a51046d0da178e288364';        // THAY THẾ: ID của cuộc trò chuyện/nhóm
const MESSAGES_PER_CLIENT = 10;                           // Số tin nhắn mỗi client sẽ gửi
const DELAY_BETWEEN_MESSAGES_MIN = 1;                     // (Giây) Độ trễ tối thiểu
const DELAY_BETWEEN_MESSAGES_MAX = 3;                     // (Giây) Độ trễ tối đa
const SESSION_DURATION_SECONDS = 60;                      // Thời gian mỗi VU giữ kết nối (tính bằng giây)
const TOKEN_FILE_PATH = './tokens_only.json';             // Đường dẫn đến file chứa token
const CLIENT_ID_MARKER_PREFIX = '[CID:';
const CLIENT_ID_MARKER_SUFFIX = ']';

// Cấu hình cho việc thử lại kết nối
const MAX_CONNECTION_ATTEMPTS = 3;                        // Số lần thử lại kết nối tối đa
const CONNECTION_RETRY_DELAY_SECONDS = 5;                 // Thời gian chờ (giây) giữa các lần thử lại
// --- END Configuration ---

// Metrics tùy chỉnh
const messageLatency = new Trend('message_latency', true);
const serverAckCounter = new Counter('server_acknowledgement_counter_total');

const connectionErrors = new Counter('connection_errors_total');
const connectionAttempts = new Counter('connection_attempts_total'); // Đếm tổng số lần thử kết nối
const messageSendAttempts = new Counter('message_send_attempts_total');
const messageEchoReceived = new Counter('message_echo_received_total');
const allMessagesReceived = new Counter('all_new_messages_received_total');
const messageProcessingErrors = new Counter('message_processing_errors_total');

const rate_echo_received_successfully = new Rate('rate_echo_received_successfully');
// --- END Metrics ---

const userTokens = new SharedArray('userTokens', function () {
    try {
        const f = JSON.parse(open(TOKEN_FILE_PATH));
        if (!Array.isArray(f) || !f.every(token => typeof token === 'string')) {
            console.error(`Token file (${TOKEN_FILE_PATH}) is not a valid JSON array of strings.`);
            return [];
        }
        return f;
    } catch (e) {
        console.error(`Error loading token file (${TOKEN_FILE_PATH}): ${e}.`);
        return [];
    }
});

export const options = {
    stages: [
        { duration: '60s', target: 1 },
        { duration: '1m', target: 10 },
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
    ],
    thresholds: {
        'http_req_failed': ['rate<0.01'], // Áp dụng cho handshake ban đầu của WebSocket
        'ws_connecting': ['p(95)<2000'],
        'message_latency': ['p(95)<1000'],
        'connection_errors_total': ['count<20'], // Tăng ngưỡng lỗi kết nối một chút do có retry
        'message_processing_errors_total': ['count<20'],
        'rate_echo_received_successfully': ['rate>0.95'],
    },
    discardResponseBodies: true,
};

export default function () {
    if (userTokens.length === 0) {
        console.error("VU aborted: No user tokens loaded.");
        return;
    }

    const tokenIndex = __VU % userTokens.length;
    const userToken = userTokens[tokenIndex];

    if (typeof userToken !== 'string' || !userToken) {
        console.error(`VU ${__VU}: Invalid or no token found at index ${tokenIndex}.`);
        return;
    }

    // --- Sử dụng cách A: HTTP polling trước để lấy sid ---
    const baseServerUrl = SERVER_URL.endsWith('/') ? SERVER_URL.slice(0, -1) : SERVER_URL;
    let sid = null;

    // 1. Thực hiện HTTP long-polling handshake trước
    try {
        console.log(`VU ${__VU}: Starting with HTTP polling handshake`);
        const pollUrl = `${baseServerUrl}/socket.io/?EIO=4&transport=polling&token=${userToken}`;
        const pollRes = http.get(pollUrl);

        if (pollRes.status === 200) {
            // Phân tích phản hồi để lấy sid
            // Định dạng của phản hồi Socket.IO là: "0{...json...}" => cần bỏ ký tự đầu tiên
            const responseText = pollRes.body;
            if (responseText && responseText.startsWith('0')) {
                try {
                    const jsonStr = responseText.substring(1);
                    const handshakeData = JSON.parse(jsonStr);
                    sid = handshakeData.sid;
                    console.log(`VU ${__VU}: Successfully got sid: ${sid}`);
                } catch (e) {
                    console.error(`VU ${__VU}: Error parsing handshake response: ${e.message}`);
                    return;
                }
            } else {
                console.error(`VU ${__VU}: Invalid handshake response format: ${responseText.substring(0, 50)}...`);
                return;
            }
        } else {
            console.error(`VU ${__VU}: HTTP polling handshake failed with status: ${pollRes.status}`);
            return;
        }
    } catch (e) {
        console.error(`VU ${__VU}: Error during HTTP polling: ${e.message}`);
        return;
    }

    if (!sid) {
        console.error(`VU ${__VU}: Could not obtain a valid sid`);
        return;
    }

    // 2. Kết nối WebSocket với sid đã lấy được
    const socketIOPath = `/socket.io/?EIO=4&transport=websocket&sid=${sid}&token=${userToken}`;
    const fullUrl = `${baseServerUrl.replace(/^http/, 'ws')}${socketIOPath}`;

    console.log(`VU ${__VU}: Connecting to WebSocket with sid: ${sid}`);
    console.log(`VU ${__VU}: Full WebSocket URL: ${fullUrl}`);

    const params = {
        headers: {
            Origin: 'http://localhost',
        },
    };

    const sentMessagesInfo = new Map();
    let handshakeResponse = null;
    let successfullyConnected = false;
    let handshakeCompleted = false;

    for (let attempt = 1; attempt <= MAX_CONNECTION_ATTEMPTS; attempt++) {
        connectionAttempts.add(1);
        console.log(`VU ${__VU}: Connection attempt ${attempt}/${MAX_CONNECTION_ATTEMPTS} to ${fullUrl}`);

        try {
            handshakeResponse = ws.connect(fullUrl, params, function (socket) {
                successfullyConnected = true;
                console.log(`VU ${__VU}: WebSocket connected (attempt ${attempt})`);

                let isSocketOpen = false;
                let pingInterval = null;

                socket.on('open', () => {
                    isSocketOpen = true;
                    console.log(`VU ${__VU}: Socket open event received.`);

                    // Khi kết nối WebSocket mở ra, gửi gói đầu tiên của Socket.IO
                    console.log(`VU ${__VU}: Sending Socket.IO connect packet (40)`);
                    socket.send('40');

                    // Thiết lập ping interval
                    if (pingInterval) clearInterval(pingInterval);
                    pingInterval = socket.setInterval(() => {
                        console.log(`VU ${__VU}: Sending ping`);
                        socket.send('2');
                    }, 20000);

                    // Đánh dấu handshake đã hoàn tất
                    handshakeCompleted = true;

                    // Join conversation sau khi kết nối thành công
                    socket.setTimeout(() => {
                        if (!isSocketOpen) return;

                        const joinPayload = JSON.stringify(["join_conversation", { data: { conversationId: CONVERSATION_ID } }]);
                        console.log(`VU ${__VU}: Joining conversation: ${CONVERSATION_ID}`);
                        socket.send(`42${joinPayload}`);

                        // Gửi các tin nhắn theo lịch trình
                        for (let i = 0; i < MESSAGES_PER_CLIENT; i++) {
                            if (!isSocketOpen) break;

                            socket.setTimeout(() => {
                                if (!isSocketOpen) return;

                                const clientGeneratedMessageId = `vu${__VU}-msg${i}-${Date.now()}`;
                                const messageContent = `Msg ${i + 1} from VU ${__VU} ${CLIENT_ID_MARKER_PREFIX}${clientGeneratedMessageId}${CLIENT_ID_MARKER_SUFFIX}`;

                                messageSendAttempts.add(1);
                                sentMessagesInfo.set(clientGeneratedMessageId, {
                                    sendTime: Date.now(),
                                    echoReceived: false,
                                });

                                const payloadData = { data: { conversationId: CONVERSATION_ID, content: messageContent } };
                                const sendMessagePayload = JSON.stringify(["send_message", payloadData]);

                                console.log(`VU ${__VU}: Sending message ${i + 1}/${MESSAGES_PER_CLIENT}`);
                                socket.send(`42${sendMessagePayload}`);
                            }, (i + 1) * (Math.random() * (DELAY_BETWEEN_MESSAGES_MAX - DELAY_BETWEEN_MESSAGES_MIN) + DELAY_BETWEEN_MESSAGES_MIN) * 1000);
                        }
                    }, 500);
                });

                socket.on('message', (msg) => {
                    if (!isSocketOpen) return;

                    console.log(`VU ${__VU}: Received message: ${msg.length > 50 ? msg.substring(0, 50) + '...' : msg}`);

                    // Xử lý tin nhắn ping từ server (Engine.IO)
                    if (msg === '2') {
                        // Trả lời pong
                        socket.send('3');
                        return;
                    }

                    // Xử lý các thông báo Socket.IO
                    if (msg.startsWith('42')) {
                        allMessagesReceived.add(1);

                        try {
                            const jsonData = JSON.parse(msg.substring(2));
                            const eventName = jsonData[0];
                            const eventData = jsonData[1];

                            if (eventName === 'message_sent' && eventData && eventData.messageId) {
                                console.log(`VU ${__VU}: Server acknowledged message: ${eventData.messageId}`);
                                serverAckCounter.add(1);
                            } else if (eventName === 'new_message' && eventData && eventData.message && eventData.message._id && eventData.message.content) {
                                const content = eventData.message.content;
                                const cidStartIndex = content.lastIndexOf(CLIENT_ID_MARKER_PREFIX);
                                const cidEndIndex = content.lastIndexOf(CLIENT_ID_MARKER_SUFFIX);

                                if (cidStartIndex !== -1 && cidEndIndex !== -1 && cidEndIndex > cidStartIndex) {
                                    const extractedClientMsgId = content.substring(cidStartIndex + CLIENT_ID_MARKER_PREFIX.length, cidEndIndex);
                                    if (sentMessagesInfo.has(extractedClientMsgId)) {
                                        const msgInfo = sentMessagesInfo.get(extractedClientMsgId);
                                        if (!msgInfo.echoReceived) {
                                            const latency = Date.now() - msgInfo.sendTime;
                                            messageLatency.add(latency);
                                            msgInfo.echoReceived = true;
                                            messageEchoReceived.add(1);
                                            rate_echo_received_successfully.add(1);
                                            sentMessagesInfo.set(extractedClientMsgId, msgInfo); // Cập nhật lại trong map
                                            console.log(`VU ${__VU}: Echo received for: ${extractedClientMsgId}, latency: ${latency}ms`);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.error(`VU ${__VU}: Error processing message: ${e.message}`);
                            messageProcessingErrors.add(1);
                        }
                    }

                    // Xử lý ping từ server
                    if (msg === '2') {
                        // Trả lời pong
                        socket.send('3');
                        return;
                    }

                    // Xử lý các thông báo Socket.IO
                    if (msg.startsWith('42')) {
                        allMessagesReceived.add(1);

                        try {
                            const jsonData = JSON.parse(msg.substring(2));
                            const eventName = jsonData[0];
                            const eventData = jsonData[1];

                            if (eventName === 'message_sent' && eventData && eventData.messageId) {
                                console.log(`VU ${__VU}: Server acknowledged message: ${eventData.messageId}`);
                                serverAckCounter.add(1);
                            } else if (eventName === 'new_message' && eventData && eventData.message && eventData.message._id && eventData.message.content) {
                                const content = eventData.message.content;
                                const cidStartIndex = content.lastIndexOf(CLIENT_ID_MARKER_PREFIX);
                                const cidEndIndex = content.lastIndexOf(CLIENT_ID_MARKER_SUFFIX);

                                if (cidStartIndex !== -1 && cidEndIndex !== -1 && cidEndIndex > cidStartIndex) {
                                    const extractedClientMsgId = content.substring(cidStartIndex + CLIENT_ID_MARKER_PREFIX.length, cidEndIndex);
                                    if (sentMessagesInfo.has(extractedClientMsgId)) {
                                        const msgInfo = sentMessagesInfo.get(extractedClientMsgId);
                                        if (!msgInfo.echoReceived) {
                                            const latency = Date.now() - msgInfo.sendTime;
                                            messageLatency.add(latency);
                                            msgInfo.echoReceived = true;
                                            messageEchoReceived.add(1);
                                            rate_echo_received_successfully.add(1);
                                            sentMessagesInfo.set(extractedClientMsgId, msgInfo); // Cập nhật lại trong map
                                            console.log(`VU ${__VU}: Echo received for: ${extractedClientMsgId}, latency: ${latency}ms`);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.error(`VU ${__VU}: Error processing message: ${e.message}`);
                            messageProcessingErrors.add(1);
                        }
                    }
                });

                const handleSessionEnd = () => {
                    if (!isSocketOpen) return;

                    isSocketOpen = false;
                    console.log(`VU ${__VU}: Ending session and checking unconfirmed messages`);

                    // Dừng ping interval
                    if (pingInterval) {
                        clearInterval(pingInterval);
                        pingInterval = null;
                    }

                    // Đánh dấu tin nhắn chưa nhận echo là thất bại
                    for (let [clientTempId, msgInfo] of sentMessagesInfo) {
                        if (!msgInfo.echoReceived) {
                            console.log(`VU ${__VU}: No echo received for: ${clientTempId}`);
                            rate_echo_received_successfully.add(0);
                        }
                    }
                    sentMessagesInfo.clear();
                };

                socket.on('close', (code) => {
                    console.log(`VU ${__VU}: WebSocket closed with code ${code}`);
                    if (!handshakeCompleted) {
                        console.error(`VU ${__VU}: Connection closed before handshake completion, code: ${code}`);
                        connectionErrors.add(1);
                    }
                    handleSessionEnd();
                });

                socket.on('error', (e) => {
                    console.error(`VU ${__VU}: WebSocket error: ${e.error()}`);
                    connectionErrors.add(1);
                    handleSessionEnd();
                });

                // Đặt thời gian kết thúc session
                socket.setTimeout(function () {
                    console.log(`VU ${__VU}: Session duration ${SESSION_DURATION_SECONDS}s reached, closing socket`);
                    handleSessionEnd();
                    socket.close();
                }, SESSION_DURATION_SECONDS * 1000);
            });

            // Kiểm tra handshake HTTP thành công
            if (handshakeResponse && handshakeResponse.status === 101) {
                console.log(`VU ${__VU}: WebSocket handshake successful (HTTP 101) on attempt ${attempt}`);
                break; // Thoát khỏi vòng lặp retry
            } else {
                console.warn(`VU ${__VU}: WebSocket handshake failed on attempt ${attempt}. Status: ${handshakeResponse ? handshakeResponse.status : 'N/A'}`);
                connectionErrors.add(1);
                if (attempt < MAX_CONNECTION_ATTEMPTS) {
                    console.log(`VU ${__VU}: Retrying in ${CONNECTION_RETRY_DELAY_SECONDS}s...`);
                    sleep(CONNECTION_RETRY_DELAY_SECONDS);
                }
            }
        } catch (e) {
            console.error(`VU ${__VU}: Connection error on attempt ${attempt}: ${e}`);
            handshakeResponse = null;
            connectionErrors.add(1);
            if (attempt < MAX_CONNECTION_ATTEMPTS) {
                console.log(`VU ${__VU}: Retrying in ${CONNECTION_RETRY_DELAY_SECONDS}s...`);
                sleep(CONNECTION_RETRY_DELAY_SECONDS);
            }
        }
    }

    // Kiểm tra xem kết nối cuối cùng có thành công không
    if (!successfullyConnected) {
        console.error(`VU ${__VU}: Failed to establish WebSocket connection after ${MAX_CONNECTION_ATTEMPTS} attempts`);
        return;
    }

    // Kiểm tra handshake HTTP
    check(handshakeResponse, {
        'WebSocket handshake successful': (r) => r && r.status === 101,
    });

    // VU tiếp tục chạy dựa trên các event WebSocket đã thiết lập
}