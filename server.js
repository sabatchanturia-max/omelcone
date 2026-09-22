const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

function uuidv4() {
  return crypto.randomBytes(4).toString('hex');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || true,
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Optional Twilio TURN
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('Twilio TURN enabled');
  } catch (e) {
    console.warn('Twilio not installed or failed:', e.message);
  }
}

const xirsysPath = process.env.XIRSYS_PATH || 'https://global.xirsys.net';
const xirsysIdent = process.env.XIRSYS_IDENT;
const xirsysSecret = process.env.XIRSYS_SECRET;
const xirsysChannel = process.env.XIRSYS_CHANNEL;

async function getXirsysIceServers() {
  if (!xirsysIdent || !xirsysSecret || !xirsysChannel) return null;

  const channel = encodeURIComponent(xirsysChannel);
  const response = await fetch(`${xirsysPath}/_turn/${channel}?webrtc=1&expire=3600`, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${Buffer.from(`${xirsysIdent}:${xirsysSecret}`).toString('base64')}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) throw new Error(`Xirsys returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.s && payload.s !== 'ok') {
    const detail = typeof payload.v === 'string' ? payload.v : JSON.stringify(payload.v || {});
    throw new Error(`Xirsys returned ${payload.s}${detail && detail !== '{}' ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const iceServers = payload.v?.iceServers || payload.iceServers || payload.v || payload;
  const normalized = Array.isArray(iceServers) ? iceServers : [iceServers];
  if (!normalized.every(server => server && typeof server === 'object' && server.urls)) {
    throw new Error('Xirsys returned an invalid ICE server response');
  }
  return normalized;
}

app.get('/ice-servers', async (req, res) => {
  const stun = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (xirsysIdent && xirsysSecret && xirsysChannel) {
    try {
      const iceServers = await getXirsysIceServers();
      if (iceServers) return res.json(iceServers);
    } catch (err) {
      console.error('Xirsys error:', err.message);
    }
  }
  if (twilioClient) {
    try {
      const token = await twilioClient.tokens.create({ ttl: 3600 });
      return res.json(token.iceServers);
    } catch (err) {
      console.error('Twilio error:', err.message);
    }
  }
  res.json(stun);
});

// ===== State =====
const waiting1v1 = new Set();           // socketIds waiting for 1v1
const waitingGroup = new Set();         // socketIds waiting for group (4)
const waitingWatch = new Set();         // socketIds waiting for Watch Together
const rooms = new Map();                // roomId -> { type: '1v1'|'group', users: Set, max: number }
const socketToRoom = new Map();         // socketId -> roomId
const socketInfo = new Map();           // socketId -> { id, roomId? }

function createRoom(type, max) {
  const id = uuidv4().slice(0, 8);
  rooms.set(id, { type, users: new Set(), max, media: { videoId: null, time: 0, playing: false } });
  return id;
}

function leaveRoom(socketId) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return null;

  const room = rooms.get(roomId);
  if (!room) {
    socketToRoom.delete(socketId);
    return null;
  }

  room.users.delete(socketId);
  socketToRoom.delete(socketId);

  // Notify others
  for (const peerId of room.users) {
    io.to(peerId).emit('peer-left', { peerId: socketId });
  }

  if (room.users.size === 0) {
    rooms.delete(roomId);
  }

  return roomId;
}

function tryMatch1v1(socket) {
  if (waiting1v1.size > 0) {
    const peerId = waiting1v1.values().next().value;
    waiting1v1.delete(peerId);

    const roomId = createRoom('1v1', 2);
    const room = rooms.get(roomId);
    room.users.add(socket.id);
    room.users.add(peerId);
    socketToRoom.set(socket.id, roomId);
    socketToRoom.set(peerId, roomId);

    // Tell both
    io.to(socket.id).emit('matched', {
      roomId,
      peers: [peerId],
      type: '1v1',
      isInitiator: socket.id > peerId
    });
    io.to(peerId).emit('matched', {
      roomId,
      peers: [socket.id],
      type: '1v1',
      isInitiator: peerId > socket.id
    });
    return true;
  }
  waiting1v1.add(socket.id);
  return false;
}

function tryMatchGroup(socket) {
  waitingGroup.add(socket.id);

  if (waitingGroup.size >= 4) {
    const peers = Array.from(waitingGroup).slice(0, 4);
    peers.forEach(id => waitingGroup.delete(id));

    const roomId = createRoom('group', 4);
    const room = rooms.get(roomId);

    peers.forEach(id => {
      room.users.add(id);
      socketToRoom.set(id, roomId);
    });

    // Notify each with the list of others
    peers.forEach(id => {
      const others = peers.filter(p => p !== id);
      io.to(id).emit('matched', {
        roomId,
        peers: others,
        type: 'group',
        isInitiator: true // mesh: each decides based on id comparison client-side
      });
    });
    return true;
  }
  return false;
}

function tryMatchWatch(socket) {
  if (waitingWatch.size > 0) {
    const peerId = waitingWatch.values().next().value;
    waitingWatch.delete(peerId);

    const roomId = createRoom('watch', 2);
    const room = rooms.get(roomId);
    room.users.add(socket.id);
    room.users.add(peerId);
    socketToRoom.set(socket.id, roomId);
    socketToRoom.set(peerId, roomId);

    io.to(socket.id).emit('matched', { roomId, peers: [peerId], type: 'watch', media: room.media });
    io.to(peerId).emit('matched', { roomId, peers: [socket.id], type: 'watch', media: room.media });
    return true;
  }
  waitingWatch.add(socket.id);
  return false;
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socketInfo.set(socket.id, { id: socket.id });

  socket.on('join-queue', ({ mode }) => {
    // Leave any existing
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);
    waitingWatch.delete(socket.id);

    if (mode === '1v1') {
      const matched = tryMatch1v1(socket);
      if (!matched) {
        socket.emit('waiting', { mode: '1v1' });
      }
    } else if (mode === 'group') {
      const matched = tryMatchGroup(socket);
      if (!matched) {
        socket.emit('waiting', { mode: 'group', count: waitingGroup.size });
      } else {
        // already emitted matched
      }
    } else if (mode === 'watch') {
      const matched = tryMatchWatch(socket);
      if (!matched) socket.emit('waiting', { mode: 'watch' });
    }
  });

  // Create private group room (code shareable)
  socket.on('create-room', () => {
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);
    waitingWatch.delete(socket.id);

    const roomId = createRoom('group', 4);
    const room = rooms.get(roomId);
    room.users.add(socket.id);
    socketToRoom.set(socket.id, roomId);

    socket.emit('room-created', { roomId, type: 'group' });
  });

  socket.on('create-watch-room', () => {
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);

    const roomId = createRoom('watch', 8);
    const room = rooms.get(roomId);
    room.users.add(socket.id);
    socketToRoom.set(socket.id, roomId);
    socket.emit('room-created', { roomId, type: 'watch' });
  });

  // Join existing room by code
  socket.on('join-room', ({ roomId }) => {
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);
    waitingWatch.delete(socket.id);

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', { message: 'ოთახი არ არსებობს' });
      return;
    }
    if (room.users.size >= room.max) {
      socket.emit('error-msg', { message: 'ოთახი სავსეა' });
      return;
    }

    // Notify existing users about new peer
    const existing = Array.from(room.users);
    room.users.add(socket.id);
    socketToRoom.set(socket.id, roomId);

    // Tell new user about existing peers
    socket.emit('matched', {
      roomId,
      peers: existing,
      type: room.type,
      isInitiator: true,
      media: room.media
    });

    // Tell existing about new peer
    existing.forEach(peerId => {
      io.to(peerId).emit('peer-joined', { peerId: socket.id });
    });
  });

  // WebRTC signaling
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Chat
  socket.on('chat', ({ message }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    for (const peerId of room.users) {
      if (peerId !== socket.id) {
        io.to(peerId).emit('chat', { from: socket.id, message });
      }
    }
  });

  socket.on('watch-control', ({ action, videoId, time, playing }) => {
    const roomId = socketToRoom.get(socket.id);
    const room = roomId && rooms.get(roomId);
    if (!room || room.type !== 'watch' || room.users.size === 0) return;

    if (typeof videoId === 'string') room.media.videoId = videoId;
    if (typeof time === 'number') room.media.time = Math.max(0, time);
    if (typeof playing === 'boolean') room.media.playing = playing;

    for (const peerId of room.users) {
      if (peerId !== socket.id) io.to(peerId).emit('watch-control', { action, ...room.media });
    }
  });

  // Leave
  socket.on('leave', () => {
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);
    waitingWatch.delete(socket.id);
    socket.emit('left');
  });

  // Next (only for 1v1 usually)
  socket.on('next', () => {
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);
    waitingWatch.delete(socket.id);
    // Client will call join-queue again
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    leaveRoom(socket.id);
    waiting1v1.delete(socket.id);
    waitingGroup.delete(socket.id);
    waitingWatch.delete(socket.id);
    socketInfo.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Ome Clone running on http://localhost:${PORT}`);
});
