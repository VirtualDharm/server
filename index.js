// server/index.js
// Simple token + signaling server for local/dev testing.
// npm i express socket.io cors agora-access-token

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const APP_ID = process.env.APP_ID || '60bdf4f5f1b641f583d20d28d7a923d1';
const APP_CERTIFICATE = process.env.APP_CERTIFICATE || '85ffadb2cbf34c4b8b7d109b7f5c8072';
if (!APP_ID || !APP_CERTIFICATE) {
  console.error('Set APP_ID and APP_CERTIFICATE env vars before running.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * GET /rtcToken?channelName=...&uid=12345
 * Returns a short-lived RTC token bound to numeric UID
 */

// Simple health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

app.get('/rtcToken', (req, res) => {
  const { channelName, uid } = req.query;
  if (!channelName || !uid) return res.status(400).json({ error: 'channelName and uid required' });

  const uidInt = Number(uid);
  if (!Number.isFinite(uidInt)) return res.status(400).json({ error: 'uid must be numeric' });

  const expireSeconds = parseInt(process.env.TOKEN_EXPIRE_S || '3600', 10); // 1 hour default
  const currentTs = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTs + expireSeconds;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      uidInt,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );
    return res.json({ rtcToken: token, uid: uidInt, channelName });
  } catch (err) {
    console.error('token error', err);
    return res.status(500).json({ error: 'token_generation_failed' });
  }
});

// ---- Socket.IO signaling ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// map userId -> socketId
const clients = {};

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('register', ({ userId }) => {
    if (!userId) return;
    clients[userId] = socket.id;
    socket.data.userId = userId;
    console.log(`registered ${userId} -> ${socket.id}`);
  });

  // caller -> server: { to: 'doctor', from: 'patient', channel, callerUid }
  socket.on('call', (payload) => {
    const { to } = payload;
    const toSocket = clients[to];
    if (toSocket) {
      io.to(toSocket).emit('incoming_call', payload);
      console.log(`forwarding incoming_call from ${payload.from} to ${to}`);
    } else {
      io.to(socket.id).emit('callee_unavailable', { to });
      console.log(`callee ${to} unavailable`);
    }
  });

  // callee accepts -> server forwards 'call_accepted' to caller
  // payload: { to: 'patient', from: 'doctor', channel, calleeUid }
  socket.on('accept_call', (payload) => {
    const toSocket = clients[payload.to];
    if (toSocket) {
      io.to(toSocket).emit('call_accepted', payload);
      console.log(`call accepted by ${payload.from} forwarded to ${payload.to}`);
    }
  });

  socket.on('reject_call', (payload) => {
    const toSocket = clients[payload.to];
    if (toSocket) {
      io.to(toSocket).emit('call_rejected', payload);
    }
  });

  socket.on('disconnect', () => {
    const uid = socket.data.userId;
    if (uid) {
      delete clients[uid];
      console.log('disconnected and removed', uid);
    }
  });

  socket.on('end_call', (payload) => {
    const toSocket = clients[payload.to];
    if (toSocket) {
      io.to(toSocket).emit('end_call', payload);
      console.log(`call ended by ${payload.from} -> notified ${payload.to}`);
    }
  });

});

server.listen(PORT, () => {
  console.log(`Token + Signaling server running on http://0.0.0.0:${PORT}`);
});

