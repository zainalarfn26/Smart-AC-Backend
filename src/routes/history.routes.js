const express = require('express');

function createHistoryRoutes({ historyController, authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, historyController.getHistory);

  return router;
}

module.exports = {
  createHistoryRoutes
};
