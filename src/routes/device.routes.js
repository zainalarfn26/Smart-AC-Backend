const express = require('express');
const {
  validateCreateDevice,
  validateUpdateDevice,
  validateSystemMode,
  validatePower,
  validateAcMode,
  validateIrLearning
} = require('../middlewares/device.validators');

function createDeviceRoutes({ deviceController, authMiddleware }) {
  const router = express.Router();

  router.get('/', authMiddleware, deviceController.getDevices);
  router.get('/:id', authMiddleware, deviceController.getDeviceById);
  router.post('/', authMiddleware, validateCreateDevice, deviceController.addDevice);
  router.put('/:id', authMiddleware, validateUpdateDevice, deviceController.updateDevice);
  router.delete('/:id', authMiddleware, deviceController.deleteDevice);

  router.post('/:id/mode', authMiddleware, validateSystemMode, deviceController.setSystemMode);
  router.post('/:id/power', authMiddleware, validatePower, deviceController.setPower);
  router.post('/:id/mode-ac', authMiddleware, validateAcMode, deviceController.setAcMode);
  router.post('/:id/ir/learn', authMiddleware, validateIrLearning, deviceController.startIrLearning);

  return router;
}

module.exports = {
  createDeviceRoutes
};
