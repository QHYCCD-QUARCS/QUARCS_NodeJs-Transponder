const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const dgram = require('dgram');
const express = require('express');
const { createServer } = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 全局总版本号（通过环境变量 QUARCS_TOTAL_VERSION 提供，格式 x.x.x）
const TOTAL_VERSION = process.env.QUARCS_TOTAL_VERSION || '0.0.0';

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
      // 统一转成字符串便于日志与 JSON 解析
      const textData = typeof data === 'string' ? data : data.toString();
      console.log(`Received message from ${clientId}: ${textData}`);

      // 尝试按 JSON 协议解析，便于对特定 type 做特殊处理
      let parsedData = null;
      try {
        parsedData = JSON.parse(textData);
      } catch (e) {
        // 非 JSON 消息，直接按原逻辑转发
      }

      // 特殊处理 Broadcast_Msg：不进行 WebSocket 转发，而是通过 UDP 广播其内容
      if (parsedData && parsedData.type === "Broadcast_Msg") {
        const payloadString = parsedData.message != null ? String(parsedData.message) : "";
        const message = Buffer.from(payloadString);

        // 每次动态获取一次当前可用的广播地址，并合并热点广播地址
        const dynamicAddrs = getBroadcastAddresses();
        const BROADCAST_ADDRS = Array.from(new Set([
          ...dynamicAddrs,
          HOTSPOT_BROADCAST_ADDR
        ]));

        if (BROADCAST_ADDRS && BROADCAST_ADDRS.length > 0) {
          BROADCAST_ADDRS.forEach((addr) => {
            udpSocket.send(message, 0, message.length, BROADCAST_PORT, addr, (err) => {
              if (err) {
                console.error(`Error sending broadcast message to ${addr}:${BROADCAST_PORT}: ${err}`);
              } else {
                console.log(`Broadcast_Msg payload sent to ${addr}:${BROADCAST_PORT}`);
                console.log(`Broadcast_Msg content: ${payloadString}`);
              }
            });
          });
        } else {
          console.error('No broadcast address found for Broadcast_Msg.');
        }

        // 返回：不再把 Broadcast_Msg 作为 WebSocket 消息转发给其它客户端
        return;
      }

      // 默认逻辑：迭代所有客户端并广播 WebSocket 消息
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

// 获取所有可用的广播地址函数（包括有线网口和热点等）
function isUsableIpv4Address(net) {
  return net &&
    (net.family === 'IPv4' || net.family === 4) &&
    !net.internal &&
    typeof net.address === 'string' &&
    typeof net.netmask === 'string';
}

function calculateBroadcastAddress(address, netmask) {
  const ipParts = address.split('.').map(Number);
  const subnetParts = netmask.split('.').map(Number);
  if (ipParts.length !== 4 || subnetParts.length !== 4 ||
      ipParts.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
      subnetParts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ipParts.map((part, i) => part | (~subnetParts[i] & 255)).join('.');
}

function getBroadcastAddresses() {
  const interfaces = os.networkInterfaces();
  const broadcastSet = new Set();
  
  for (let name of Object.keys(interfaces)) {
    for (let net of interfaces[name]) {
      // 跳过IPv6和非内部网络接口
      if (isUsableIpv4Address(net)) {
        const broadcastAddr = calculateBroadcastAddress(net.address, net.netmask);
        if (!broadcastAddr) continue;
        broadcastSet.add(broadcastAddr);
      }
    }
  }
  return Array.from(broadcastSet);
}

// 树莓派热点广播地址（可通过环境变量 QUARCS_HOTSPOT_BROADCAST_ADDR 覆盖，默认 10.42.0.255）
// 注意：如果你希望固定向 10.42.0.1（热点本机地址）发送，也可以把该环境变量设为 10.42.0.1
const HOTSPOT_BROADCAST_ADDR = process.env.QUARCS_HOTSPOT_BROADCAST_ADDR || '10.42.0.255';

// 自动获取所有广播地址（包含树莓派热点和其它网口）
const BROADCAST_PORT = 8080;
const BROADCAST_INTERVAL_SEC = 1000; // 广播间隔时间（毫秒）
const NETWORK_WATCH_INTERVAL_MS = Number(process.env.QUARCS_NETWORK_WATCH_INTERVAL_MS || 1000);

// 创建 UDP 套接字
const udpSocket = dgram.createSocket('udp4');

let networkBroadcastSequence = 1;
let lastNetworkSignature = '';

// 设置广播权限
udpSocket.on('listening', () => {
  udpSocket.setBroadcast(true);
  console.log(`UDP socket is listening and ready to broadcast on port ${BROADCAST_PORT}`);
});

function buildNetworkSnapshot() {
  const interfaces = os.networkInterfaces();
  const records = [];

  for (const [name, nets] of Object.entries(interfaces)) {
    for (const net of nets || []) {
      if (!isUsableIpv4Address(net)) continue;

      const broadcastAddr = calculateBroadcastAddress(net.address, net.netmask);
      if (!broadcastAddr) continue;

      records.push({
        name,
        address: net.address,
        netmask: net.netmask,
        mac: net.mac || '',
        cidr: net.cidr || '',
        broadcast: broadcastAddr
      });
    }
  }

  records.sort((a, b) => {
    const left = `${a.name}|${a.address}|${a.netmask}|${a.mac}|${a.broadcast}`;
    const right = `${b.name}|${b.address}|${b.netmask}|${b.mac}|${b.broadcast}`;
    return left.localeCompare(right);
  });

  return records;
}

function getBroadcastAddressesFromSnapshot(snapshot) {
  const broadcastSet = new Set((snapshot || []).map(item => item.broadcast).filter(Boolean));
  if (HOTSPOT_BROADCAST_ADDR) {
    broadcastSet.add(HOTSPOT_BROADCAST_ADDR);
  }
  if (broadcastSet.size === 0) {
    broadcastSet.add('255.255.255.255');
  }
  return Array.from(broadcastSet);
}

function buildBroadcastPayload(reason, snapshot, sequence) {
  const compactIfaces = (snapshot || [])
    .map(item => `${item.name}=${item.address}`)
    .join(',');

  return `Stellarium Shared Memory Service| Vh = ${TOTAL_VERSION}| Seq = ${sequence}| Reason = ${reason}| Ifaces = ${compactIfaces}`;
}

function sendUdpBroadcast(payload, addrs) {
  const message = Buffer.from(payload);
  if (addrs && addrs.length > 0) {
    addrs.forEach((addr) => {
      udpSocket.send(message, 0, message.length, BROADCAST_PORT, addr, (err) => {
        if (err) {
          console.error(`Error sending broadcast message to ${addr}:${BROADCAST_PORT}: ${err}`);
        } else {
          console.log(`Broadcast message sent to ${addr}:${BROADCAST_PORT}`);
        }
      });
    });
  } else {
    console.error('No broadcast address found.');
  }
}

function broadcastServiceSignal(reason = 'periodic') {
  const snapshot = buildNetworkSnapshot();
  const addrs = getBroadcastAddressesFromSnapshot(snapshot);
  const payload = buildBroadcastPayload(reason, snapshot, networkBroadcastSequence);
  sendUdpBroadcast(payload, addrs);
}

function refreshNetworkStateAndBroadcastIfNeeded() {
  const snapshot = buildNetworkSnapshot();
  const signature = JSON.stringify(snapshot);

  if (!lastNetworkSignature) {
    lastNetworkSignature = signature;
    return;
  }

  if (signature !== lastNetworkSignature) {
    lastNetworkSignature = signature;
    networkBroadcastSequence += 1;

    const addrs = getBroadcastAddressesFromSnapshot(snapshot);
    const payload = buildBroadcastPayload('network_change', snapshot, networkBroadcastSequence);

    console.log(`Network change detected, broadcast sequence -> ${networkBroadcastSequence}`);
    sendUdpBroadcast(payload, addrs);
  }
}

// 定时广播消息
setInterval(() => {
  broadcastServiceSignal('periodic');
}, BROADCAST_INTERVAL_SEC);

// 实时监听网络变化并编号广播
setInterval(() => {
  refreshNetworkStateAndBroadcastIfNeeded();
}, NETWORK_WATCH_INTERVAL_MS);

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
