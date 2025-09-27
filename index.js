// server/index.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

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
  console.log('Health check requested');
  res.status(200).json({ status: 'ok', message: 'Server is running' });
  console.log('Health check response sent');
});

app.get('/rtcToken', (req, res) => {
  const { channelName, uid } = req.query;
  console.log(`RTC token request: channelName=${channelName}, uid=${uid}`);
  if (!channelName || !uid) {
    console.log('Missing channelName or uid in RTC token request');
    return res.status(400).json({ error: 'channelName and uid required' });
  }

  const uidInt = Number(uid);
  if (!Number.isFinite(uidInt)) {
    console.log('Invalid uid in RTC token request - not numeric');
    return res.status(400).json({ error: 'uid must be numeric' });
  }

  const expireSeconds = parseInt(process.env.TOKEN_EXPIRE_S || '3600', 10); // 1 hour default
  const currentTs = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTs + expireSeconds;
  console.log(`Generating RTC token: expireSeconds=${expireSeconds}, currentTs=${currentTs}, privilegeExpiredTs=${privilegeExpiredTs}`);

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      uidInt,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );
    console.log(`RTC token generated successfully for uid=${uidInt}, channelName=${channelName}`);
    return res.json({ rtcToken: token, uid: uidInt, channelName });
  } catch (err) {
    console.error('Token generation error:', err);
    return res.status(500).json({ error: 'token_generation_failed' });
  }
});

// ---- Socket.IO signaling ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// userId -> { socketId?, pushToken? }
const clients = {};

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('register', ({ userId }) => {
    console.log(`Register event received: userId=${userId}`);
    if (!userId) {
      console.log('Missing userId in register event');
      return;
    }
    if (!clients[userId]) clients[userId] = {};
    clients[userId].socketId = socket.id;
    socket.data.userId = userId;
    console.log(`Registered userId=${userId} -> socketId=${socket.id}`);
  });

  socket.on('register_push', ({ userId, pushToken }) => {
    console.log(`Register push event received: userId=${userId}, pushToken=${pushToken}`);
    if (!userId || !pushToken) {
      console.log('Missing userId or pushToken in register_push event');
      return;
    }
    if (!clients[userId]) clients[userId] = {};
    clients[userId].pushToken = pushToken;
    console.log(`Registered push token for userId=${userId}: ${pushToken}`);
  });

  socket.on('call', (payload) => {
    console.log('Call event received:', payload);
    const { to } = payload;
    const toClient = clients[to];
    if (toClient?.socketId) {
      io.to(toClient.socketId).emit('incoming_call', payload);
      console.log(`Forwarded incoming_call from ${payload.from} to ${to} (socketId=${toClient.socketId})`);
    } else {
      io.to(socket.id).emit('callee_unavailable', { to });
      console.log(`Callee ${to} unavailable - notified caller`);
    }
  });

  socket.on('accept_call', (payload) => {
    console.log('Accept call event received:', payload);
    const toSocket = clients[payload.to]?.socketId;
    if (toSocket) {
      io.to(toSocket).emit('call_accepted', payload);
      console.log(`Call accepted by ${payload.from} - forwarded to ${payload.to} (socketId=${toSocket})`);
    } else {
      console.log(`Cannot forward accept_call - no socket for ${payload.to}`);
    }
  });

  socket.on('reject_call', (payload) => {
    console.log('Reject call event received:', payload);
    const toSocket = clients[payload.to]?.socketId;
    if (toSocket) {
      io.to(toSocket).emit('call_rejected', payload);
      console.log(`Call rejected by ${payload.from} - forwarded to ${payload.to} (socketId=${toSocket})`);
    } else {
      console.log(`Cannot forward reject_call - no socket for ${payload.to}`);
    }
  });

  socket.on('end_call', (payload) => {
    console.log('End call event received:', payload);
    const toSocket = clients[payload.to]?.socketId;
    if (toSocket) {
      io.to(toSocket).emit('end_call', payload);
      console.log(`Call ended by ${payload.from} - notified ${payload.to} (socketId=${toSocket})`);
    } else {
      console.log(`Cannot forward end_call - no socket for ${payload.to}`);
    }
  });

  socket.on('disconnect', () => {
    const uid = socket.data.userId;
    console.log(`Socket disconnected: socketId=${socket.id}, userId=${uid}`);
    if (uid) {
      if (clients[uid]) delete clients[uid].socketId;
      console.log(`Disconnected and removed socketId for userId=${uid}`);
    }
  });
});

// REST endpoint for sending push (used by patient-app)
app.post('/sendPush', async (req, res) => {
  console.log('sendPush endpoint called with body:', req.body);
  const { to, from, channel } = req.body;
  const toClient = clients[to];
  if (!toClient?.pushToken) {
    console.log(`No push token for recipient userId=${to}`);
    return res.status(400).json({ error: 'No push token for recipient' });
  }

  console.log(`Preparing to send push to userId=${to}, pushToken=${toClient.pushToken}, from=${from}, channel=${channel}`);

  try {
    const pushResponse = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: toClient.pushToken,
        title: 'Incoming Call',
        body: `${from} is calling you`,
        data: { type: 'incoming_call', from, channel },
      }),
    });
    console.log(`Push sent to userId=${to} - response status: ${pushResponse.status}`);
    if (!pushResponse.ok) {
      const errorText = await pushResponse.text();
      console.error(`Push send failed with status ${pushResponse.status}: ${errorText}`);
    } else {
      console.log(`Push sent successfully to userId=${to}`);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Push send error:', err);
    return res.status(500).json({ error: 'push_failed' });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});