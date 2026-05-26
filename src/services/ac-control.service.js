const { buildIrClonePayload } = require('./ir-clone.service');

function createAcControlService({ db, getMqttClient, io }) {
  function getClient() {
    const mqttClient = getMqttClient();
    if (!mqttClient) {
      throw new Error('MQTT client belum siap.');
    }
    return mqttClient;
  }

  async function turnOnAcAutomatically(room, suhuAktual) {
    const deviceId = room.device_id;

    const mqttClient = getClient();
    mqttClient.publish(
      `smartac/control/${deviceId}`,
      JSON.stringify({
        power: 'ON',
        merk: room.merk_ac,
        ir_clone: buildIrClonePayload(room)
      })
    );

    await db.query('UPDATE ruangan SET status_ac = ? WHERE device_id = ?', ['ON', deviceId]);
    await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)',
      [deviceId, 'ON', 'Otomatis (Ada Orang)', suhuAktual]);
    console.log(`⚡ Aktuasi AC ${room.nama_ruangan}: ON - Pemicu: Otomatis (Ada Orang)`);

    room.status_ac = 'ON';

    io.emit('ac:update', {
      device_id: deviceId,
      status_ac: 'ON',
      action: 'ON',
      pemicu: 'Otomatis (Ada Orang)'
    });
  }

  function determineAutoMode(room, suhuAktual) {
    const currentMode = room.mode_ac || 'NORMAL';

    if (suhuAktual >= Number(room.batas_atas) && currentMode !== 'TURBO') {
      return {
        modeToChange: 'TURBO',
        pemicuMode: `Otomatis (Hysteresis Atas: ${suhuAktual}°C)`
      };
    }

    if (suhuAktual <= Number(room.batas_bawah) && currentMode !== 'NORMAL') {
      return {
        modeToChange: 'NORMAL',
        pemicuMode: `Otomatis (Hysteresis Bawah: ${suhuAktual}°C)`
      };
    }

    return null;
  }

  async function changeAcModeAutomatically(room, suhuAktual, modeToChange, pemicuMode) {
    const deviceId = room.device_id;

    const mqttClient = getClient();
    mqttClient.publish(
      `smartac/control/${deviceId}`,
      JSON.stringify({
        mode: modeToChange,
        merk: room.merk_ac,
        ir_clone: buildIrClonePayload(room)
      })
    );

    await db.query('UPDATE ruangan SET mode_ac = ? WHERE device_id = ?', [modeToChange, deviceId]);
    await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)',
      [deviceId, `MODE ${modeToChange}`, pemicuMode, suhuAktual]);
    console.log(`❄️ Ubah Mode AC ${room.nama_ruangan}: ${modeToChange} - Pemicu: ${pemicuMode}`);

    room.mode_ac = modeToChange;

    io.emit('ac:update', {
      device_id: deviceId,
      mode_ac: modeToChange,
      action: `MODE ${modeToChange}`,
      pemicu: pemicuMode
    });
  }

  async function applyAutoOnAndHysteresis({ room, statusKehadiran, suhuAktual }) {
    if (statusKehadiran === 'Ada Orang' && room.status_ac === 'OFF') {
      await turnOnAcAutomatically(room, suhuAktual);
    }

    if (room.status_ac !== 'ON') {
      return;
    }

    const modeDecision = determineAutoMode(room, suhuAktual);
    if (!modeDecision) {
      return;
    }

    await changeAcModeAutomatically(
      room,
      suhuAktual,
      modeDecision.modeToChange,
      modeDecision.pemicuMode
    );
  }

  return {
    applyAutoOnAndHysteresis
  };
}

module.exports = {
  createAcControlService
};
