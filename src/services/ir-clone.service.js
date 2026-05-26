const IR_TARGET_COLUMNS = {
  POWER_ON: 'ir_power_on_code',
  POWER_OFF: 'ir_power_off_code',
  TURBO: 'ir_turbo_code',
  NORMAL: 'ir_normal_code'
};

function normalizeIrTarget(target) {
  const normalized = (target || '').toString().trim().toUpperCase();

  if (!IR_TARGET_COLUMNS[normalized]) {
    throw new Error("Target cloning harus 'POWER_ON', 'POWER_OFF', 'TURBO', atau 'NORMAL'.");
  }

  return normalized;
}

function parseRawArraySignal(signal) {
  if (Array.isArray(signal)) {
    return signal.map((value) => Number(value));
  }

  if (signal && typeof signal === 'object') {
    if (Array.isArray(signal.raw_data)) {
      return signal.raw_data.map((value) => Number(value));
    }

    if (Array.isArray(signal.data)) {
      return signal.data.map((value) => Number(value));
    }
  }

  if (typeof signal === 'string') {
    const trimmed = signal.trim();

    if (!trimmed) {
      throw new Error('Sinyal IR tidak boleh kosong.');
    }

    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        return parsed.map((value) => Number(value));
      }

      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.raw_data)) {
          return parsed.raw_data.map((value) => Number(value));
        }

        if (Array.isArray(parsed.data)) {
          return parsed.data.map((value) => Number(value));
        }
      }
    } catch (err) {
      // fall through to validation error below
    }
  }

  throw new Error('Format sinyal IR tidak valid. Harus berupa array raw atau JSON array.');
}

function isSimilarArray(a, b, relTol = 0.15) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    const maxv = Math.max(Math.abs(av), Math.abs(bv), 1);
    if (Math.abs(av - bv) / maxv > relTol) return false;
  }
  return true;
}

function roundDurations(arr, step = 50) {
  return arr.map((v) => Math.round(Number(v) / step) * step);
}

function trimSmallGaps(arr, minThreshold = 50) {
  // remove leading/trailing very small values
  let start = 0;
  while (start < arr.length && Math.abs(Number(arr[start])) <= minThreshold) start++;
  let end = arr.length - 1;
  while (end >= 0 && Math.abs(Number(arr[end])) <= minThreshold) end--;
  if (start > end) return [];
  return arr.slice(start, end + 1);
}

function detectAndCollapseRepeatFrames(arr) {
  // try to find a repeated frame pattern and return the first frame if detected
  const n = arr.length;
  for (let frameLen = 8; frameLen <= Math.floor(n / 2); frameLen++) {
    if (n % frameLen !== 0) continue;
    const chunks = [];
    for (let i = 0; i < n; i += frameLen) chunks.push(arr.slice(i, i + frameLen));
    const first = chunks[0];
    let allSimilar = true;
    for (let j = 1; j < chunks.length; j++) {
      if (!isSimilarArray(first, chunks[j])) {
        allSimilar = false;
        break;
      }
    }
    if (allSimilar && chunks.length > 1) return first;
  }
  // fallback: also check if first half ~ second half even if not exact divisor
  if (n >= 16) {
    const half = Math.floor(n / 2);
    const a = arr.slice(0, half);
    const b = arr.slice(half, half + a.length);
    if (isSimilarArray(a, b)) return a;
  }
  return arr;
}

function normalizeIrSignal(rawArr) {
  // ensure numbers
  let arr = rawArr.map((v) => Number(v)).filter((v) => Number.isFinite(v));

  if (arr.length === 0) return [];

  // remove leading small gaps
  arr = trimSmallGaps(arr, 60);

  // round durations to 50µs for stability
  arr = roundDurations(arr, 50);

  // drop tiny noise
  arr = arr.filter((v) => Math.abs(v) >= 40);

  if (arr.length === 0) return [];

  // collapse repeated frames (if present)
  arr = detectAndCollapseRepeatFrames(arr);

  return arr;
}

function serializeIrSignal(signal) {
  const normalizedSignal = parseRawArraySignal(signal);

  if (normalizedSignal.length === 0) {
    throw new Error('Sinyal IR tidak boleh kosong.');
  }

  const normalized = normalizeIrSignal(normalizedSignal);
  if (!Array.isArray(normalized) || normalized.length === 0) {
    throw new Error('Sinyal IR tidak valid setelah normalisasi.');
  }

  return JSON.stringify(normalized);
}

function buildIrClonePayload(room) {
  return {
    learning_state: room.ir_learning_state || 'IDLE',
    learning_target: room.ir_learning_target || null,
    power_on: room.ir_power_on_code || null,
    power_off: room.ir_power_off_code || null,
    turbo: room.ir_turbo_code || null,
    normal: room.ir_normal_code || null
  };
}

function hasAnyCloneData(room) {
  return [
    room.ir_power_on_code,
    room.ir_power_off_code,
    room.ir_turbo_code,
    room.ir_normal_code
  ].some((value) => value != null && value.toString().trim() !== '');
}

function createIrCloneService({ db, io, getMqttClient }) {
  const learningTimeouts = new Map();

  function getClient() {
    const mqttClient = getMqttClient();
    if (!mqttClient) {
      throw new Error('MQTT client belum siap.');
    }

    return mqttClient;
  }

  function clearLearningTimeout(deviceId) {
    const timer = learningTimeouts.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      learningTimeouts.delete(deviceId);
    }
  }

  async function emitLearningState(deviceId, room, learningState, target = null, reason = null) {
    io.emit('ir:update', {
      device_id: deviceId,
      learning_state: learningState,
      learning_target: target,
      ir_clone_ready: hasAnyCloneData(room),
      ...(reason ? { reason } : {})
    });
  }

  async function startLearning({ room, target }) {
    const targetUpper = normalizeIrTarget(target);
    const deviceId = room.device_id;

    clearLearningTimeout(deviceId);

    await db.query(
      'UPDATE ruangan SET ir_learning_state = ?, ir_learning_target = ? WHERE device_id = ?',
      ['LEARNING', targetUpper, deviceId]
    );

    getClient().publish(
      `smartac/control/${deviceId}`,
      JSON.stringify({ command: 'START_LEARNING', target: targetUpper, merk: room.merk_ac })
    );

    await emitLearningState(deviceId, room, 'LEARNING', targetUpper);

    learningTimeouts.set(
      deviceId,
      setTimeout(async () => {
        try {
          const [rows] = await db.query(
            'SELECT * FROM ruangan WHERE device_id = ?',
            [deviceId]
          );

          if (rows.length === 0) {
            clearLearningTimeout(deviceId);
            return;
          }

          const currentRoom = rows[0];
          const currentState = (currentRoom.ir_learning_state || '').toString().toUpperCase();
          const currentTarget = (currentRoom.ir_learning_target || '').toString().toUpperCase();

          if (currentState !== 'LEARNING' || currentTarget !== targetUpper) {
            clearLearningTimeout(deviceId);
            return;
          }

          await db.query(
            'UPDATE ruangan SET ir_learning_state = ?, ir_learning_target = NULL WHERE device_id = ?',
            ['FAILED', deviceId]
          );

          await emitLearningState(deviceId, { ...currentRoom, ir_learning_state: 'FAILED', ir_learning_target: null }, 'FAILED', null, 'TIMEOUT');
        } catch (error) {
          console.error(`Gagal memproses timeout cloning IR untuk ${deviceId}:`, error);
        } finally {
          clearLearningTimeout(deviceId);
        }
      }, 20000)
    );
  }

  async function storeCapturedSignal({ deviceId, target, signal }) {
    const [rows] = await db.query(
      'SELECT * FROM ruangan WHERE device_id = ?',
      [deviceId]
    );

    if (rows.length === 0) {
      return false;
    }

    const currentRoom = rows[0];
    const targetUpper = normalizeIrTarget(target || currentRoom.ir_learning_target);
    const serializedSignal = serializeIrSignal(signal);
    const column = IR_TARGET_COLUMNS[targetUpper];

    clearLearningTimeout(deviceId);

    await db.query(
      `UPDATE ruangan SET ${column} = ?, ir_learning_state = ?, ir_learning_target = NULL WHERE device_id = ?`,
      [serializedSignal, 'READY', deviceId]
    );

    await emitLearningState(
      deviceId,
      { ...currentRoom, [column]: serializedSignal, ir_learning_state: 'READY', ir_learning_target: null },
      'READY',
      null
    );

    return true;
  }

  return {
    buildIrClonePayload,
    startLearning,
    storeCapturedSignal,
    normalizeIrTarget
  };
}

module.exports = {
  createIrCloneService,
  buildIrClonePayload,
  normalizeIrTarget
};