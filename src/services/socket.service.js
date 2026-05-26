const { Server } = require('socket.io');

function createSocketServer(server, corsOrigin) {
  const io = new Server(server, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Frontend terhubung via WebSocket: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`🔌 Frontend terputus: ${socket.id}`);
    });
  });

  return io;
}

module.exports = {
  createSocketServer
};
