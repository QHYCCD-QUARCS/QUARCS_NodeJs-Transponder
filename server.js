const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const dgram = require('dgram');
const express = require('express');
const { createServer } = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 创建 Express 应用
const app = express();

// 启用CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 设置静态文件目录
app.use('/images', express.static('/dev/shm'));

// SSL证书配置
const certPath = path.join(__dirname, 'certs');
const sslOptions = {
  key: fs.readFileSync(path.join(certPath, 'stellarium.key')),
  cert: fs.readFileSync(path.join(certPath, 'stellarium.crt'))
};

// 创建 HTTP 和 HTTPS 服务器
const httpServer = createServer(app);
const httpsServer = https.createServer(sslOptions, app);

// 创建 WebSocket 服务器
const wssHttp = new WebSocket.Server({ server: httpServer });
const wssHttps = new WebSocket.Server({ 
  server: httpsServer,
  // 允许自签名证书
  rejectUnauthorized: false,
  // 添加错误处理
  clientTracking: true,
  perMessageDeflate: false
});

// 添加错误处理
httpsServer.on('error', (error) => {
  console.error('HTTPS Server Error:', {
    message: error.message,
    code: error.code,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
});

wssHttps.on('error', (error) => {
  console.error('WSS Server Error:', {
    message: error.message,
    code: error.code,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
});

// 添加连接错误处理
wssHttps.on('connection', (ws, req) => {
  console.log('New WSS connection attempt from:', {
    ip: req.socket.remoteAddress,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
  
  ws.on('error', (error) => {
    console.error('WSS Client Error:', {
      message: error.message,
      code: error.code,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  });
});

// 共享的WebSocket处理逻辑
function setupWebSocketServer(wss) {
  wss.on('connection', function connection(ws, req) {
    console.log('New connection from:', req.socket.remoteAddress);
    const clientId = uuidv4();
    ws.id = clientId;

    console.log(`Client ${clientId} connected from ${req.socket.remoteAddress}`);

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    // 通知所有连接的客户端有新客户端连接
    const newClientMessage = {
      type: "Server_msg",
      message: `Client ${clientId} connected from ${req.socket.remoteAddress}`
    };
    wss.clients.forEach(function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(newClientMessage));
      }
    });

    ws.on('message', function message(data, isBinary) {
      console.log(`Received message from ${clientId}: ${data}`);
      // 迭代所有客户端并广播消息
      wss.clients.forEach(function each(client) {
        // 检查WebSocket是否打开并且不是发送消息的客户端
        if (client.readyState === WebSocket.OPEN && client.id !== ws.id) {
          client.send(data, { binary: isBinary });
        }
      });
    });

    // 当客户端断开连接时
    ws.on('close', function close() {
      console.log(`Client ${clientId} disconnected`);

      // 创建要发送的 JSON 消息
      const messageObj = {
        type: "Server_msg",
        message: `Client ${clientId} disconnected`
      };

      // 通知所有连接的客户端
      wss.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(messageObj));
        }
      });
    });

    ws.on('error', console.error);
  });
}

// 设置WebSocket服务器
setupWebSocketServer(wssHttp);
setupWebSocketServer(wssHttps);

// 让 HTTP 服务器监听特定端口
httpServer.listen(8600, () => {
  console.log('HTTP and WebSocket server started on ws://localhost:8600');
});

// 让 HTTPS 服务器监听特定端口
httpsServer.listen(8601, () => {
  console.log('HTTPS and WSS server started on wss://localhost:8601');
});

// 获取广播地址函数
function getBroadcastAddress() {
  const interfaces = os.networkInterfaces();
  
  for (let name of Object.keys(interfaces)) {
    for (let net of interfaces[name]) {
      // 跳过IPv6和非内部网络接口
      if (net.family === 'IPv4' && !net.internal) {
        const ipParts = net.address.split('.').map(Number);
        const subnetParts = net.netmask.split('.').map(Number);
        
        // 计算广播地址
        const broadcastParts = ipParts.map((part, i) => part | (~subnetParts[i] & 255));
        return broadcastParts.join('.');
      }
    }
  }
  return null;
}

// 自动获取广播地址
const BROADCAST_PORT = 8080;
const BROADCAST_ADDR = getBroadcastAddress(); // 自动获取的广播地址
const BROADCAST_INTERVAL_SEC = 2000; // 广播间隔时间（毫秒）

// 创建 UDP 套接字
const udpSocket = dgram.createSocket('udp4');

// 设置广播权限
udpSocket.on('listening', () => {
  udpSocket.setBroadcast(true);
  console.log(`UDP socket is listening and ready to broadcast on port ${BROADCAST_PORT}`);
});

// 定时广播消息
setInterval(() => {
  const message = Buffer.from('Stellarium Shared Memory Service');
  if (BROADCAST_ADDR) {
    udpSocket.send(message, 0, message.length, BROADCAST_PORT, BROADCAST_ADDR, (err) => {
      if (err) {
        console.error(`Error sending broadcast message: ${err}`);
      } else {
        // 打印广播发送的地址和端口
        console.log(`Broadcast message sent to ${BROADCAST_ADDR}:${BROADCAST_PORT}`);
      }
    });
  } else {
    console.error('No broadcast address found.');
  }
}, BROADCAST_INTERVAL_SEC);

// 启动 UDP socket
udpSocket.bind(BROADCAST_PORT);

// WebSocket 心跳功能
function noop() {}

function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(function ping() {
  wssHttp.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {
      console.log(`Client ${ws.id} did not respond to a ping, terminating.`);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping(noop);
  });

  wssHttps.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {
      console.log(`Client ${ws.id} did not respond to a ping, terminating.`);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping(noop);
  });
}, 3000); // 设置为3秒，可以根据需要调整

// 清理心跳检查间隔
wssHttp.on('close', function close() {
  clearInterval(interval);
});

wssHttps.on('close', function close() {
  clearInterval(interval);
});

console.log('Server started successfully!');