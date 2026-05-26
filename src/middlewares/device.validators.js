function validationError(res, message) {
  return res.status(400).json({ error: message });
}

function validateCreateDevice(req, res, next) {
  const { nama, device_id, batas_atas, batas_bawah } = req.body;

  if (!nama || !device_id) {
    return validationError(res, 'Nama ruangan dan device_id wajib diisi.');
  }

  if (batas_atas == null || batas_bawah == null) {
    return validationError(res, 'Batas atas dan batas bawah suhu wajib diisi.');
  }

  if (Number(batas_bawah) >= Number(batas_atas)) {
    return validationError(res, 'Batas bawah harus lebih kecil dari batas atas.');
  }

  next();
}

function validateUpdateDevice(req, res, next) {
  const { merk_ac, batas_atas, batas_bawah } = req.body;

  if (!merk_ac || batas_atas == null || batas_bawah == null) {
    return validationError(res, 'Merk AC, batas atas, dan batas bawah wajib diisi.');
  }

  if (Number(batas_bawah) >= Number(batas_atas)) {
    return validationError(res, 'Batas bawah harus lebih kecil dari batas atas.');
  }

  next();
}

function validateSystemMode(req, res, next) {
  const modeUpper = req.body.mode?.toUpperCase();
  if (!modeUpper || !['AUTO', 'MANUAL'].includes(modeUpper)) {
    return validationError(res, "Mode harus 'AUTO' atau 'MANUAL'.");
  }

  next();
}

function validatePower(req, res, next) {
  const statusUpper = req.body.status?.toUpperCase();
  if (!statusUpper || !['ON', 'OFF'].includes(statusUpper)) {
    return validationError(res, "Status harus 'ON' atau 'OFF'.");
  }

  next();
}

function validateAcMode(req, res, next) {
  const modeUpper = req.body.mode_ac?.toUpperCase();
  if (!modeUpper || !['TURBO', 'NORMAL'].includes(modeUpper)) {
    return validationError(res, "Mode AC harus 'TURBO' atau 'NORMAL'.");
  }

  next();
}

function validateIrLearning(req, res, next) {
  const targetUpper = req.body.target?.toUpperCase();
  if (!targetUpper || !['POWER_ON', 'POWER_OFF', 'TURBO', 'NORMAL'].includes(targetUpper)) {
    return validationError(res, "Target cloning harus 'POWER_ON', 'POWER_OFF', 'TURBO', atau 'NORMAL'.");
  }

  next();
}

module.exports = {
  validateCreateDevice,
  validateUpdateDevice,
  validateSystemMode,
  validatePower,
  validateAcMode,
  validateIrLearning
};
