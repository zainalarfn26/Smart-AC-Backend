const express = require('express');
const cors = require('cors');
const http = require('http');

const {
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  CORS_ORIGIN,
  MQTT_BROKER,
  MQTT_PORT
} = require('./config/env');
const { createDbPool, testDbConnection } = require('./config/db');
const { createAuthMiddleware } = require('./middlewares/auth');
const { createSocketServer } = require('./services/socket.service');
const { createMqttService } = require('./services/mqtt.service');
const { createAcControlService } = require('./services/ac-control.service');
const { createIrCloneService } = require('./services/ir-clone.service');
const { createAuthController } = require('./controllers/auth.controller');
const { createDeviceController } = require('./controllers/device.controller');
const { createHistoryController } = require('./controllers/history.controller');
const { createAuthRoutes } = require('./routes/auth.routes');
const { createDeviceRoutes } = require('./routes/device.routes');
const { createHistoryRoutes } = require('./routes/history.routes');

function createAppServer() {
  const app = express();
  const server = http.createServer(app);

  app.use(cors({
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.use(express.json());

  const db = createDbPool();
  const authMiddleware = createAuthMiddleware(JWT_SECRET);
  const io = createSocketServer(server, CORS_ORIGIN);
  let mqttClient;
  const irCloneService = createIrCloneService({
    db,
    io,
    getMqttClient: () => mqttClient
  });
  const acControlService = createAcControlService({
    db,
    getMqttClient: () => mqttClient,
    io
  });

  const absenceTimers = {};
  const DELAY_MATI_AC = 15 * 60 * 1000;

  const mqttService = createMqttService({
    broker: MQTT_BROKER,
    port: MQTT_PORT,
    db,
    io,
    absenceTimers,
    delayAutoOffMs: DELAY_MATI_AC,
    acControlService,
    irCloneService
  });
  mqttClient = mqttService.mqttClient;

  const authController = createAuthController({
    db,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: JWT_EXPIRES_IN
  });

  const deviceController = createDeviceController({
    db,
    mqttClient,
    io,
    absenceTimers,
    acControlService,
    irCloneService
  });

  const historyController = createHistoryController({ db });

  app.use('/api/auth', createAuthRoutes({ authController, authMiddleware }));
  app.use('/api/devices', createDeviceRoutes({ deviceController, authMiddleware }));
  app.use('/api/history', createHistoryRoutes({ historyController, authMiddleware }));

  async function start() {
    await testDbConnection(db);

    server.listen(PORT, () => {
      console.log(`🚀 Server Backend berjalan di http://localhost:${PORT}`);
      console.log('🔌 WebSocket aktif untuk real-time updates');
    });
  }

  return {
    app,
    server,
    start
  };
}

module.exports = {
  createAppServer
};
