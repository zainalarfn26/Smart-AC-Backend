require('dotenv').config();

const { createAppServer } = require('./src/app');

const { start } = createAppServer();
start();
