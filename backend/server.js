import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes.js';
import sessionRoutes from './routes/sessionRoutes.js';
import {ExpressPeerServer} from 'peer';
import http from 'http';
import { Server } from 'socket.io';

dotenv.config();

const app = express();

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND,
    credentials: true,
  }
});

const customGenerationFunction = () =>
  (Math.random().toString(36) + "0000000000000000000").substring(2, 16);

const pServer = app.listen(443);

const peerServer = ExpressPeerServer(pServer, {
  debug: true,
  proxied: true,
  path: '/app',
  generateClientId: customGenerationFunction,
});

app.use(peerServer);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected successfully'))
.catch((error) => console.error('MongoDB connection error:', error));

// Routes
app.use('/api', authRoutes);
app.use('/api', sessionRoutes);

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "*");
  next();
});

// Error handling
app.use((req, res, next) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

// only start the server if not running tests
if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 4000;
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

io.on("connection", (socket) => {
  socket.on("join_session", (sessionId, id, username) => {
    socket.join(sessionId);
    socket.to(sessionId).emit("user_connection", id, username);

    socket.on("leave_session", () => {
      socket.to(sessionId).emit("user_disconnection", id);
      socket.leave(sessionId);
    });

    socket.on("send_file", (file) => {
      socket.to(sessionId).emit("send_file", file);
    });
  });
});

server.listen(3030);
// export the app for testing
export default app;
