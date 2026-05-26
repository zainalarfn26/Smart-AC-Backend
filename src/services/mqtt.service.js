const mqtt = require('mqtt');
const { buildIrClonePayload } = require('./ir-clone.service');

function createMqttService({
  broker,
  port,
  db,
  io,
  absenceTimers,
  delayAutoOffMs,
  acControlService,
  irCloneService
}) {
  const mqttClient = mqtt.connect(broker, { port: Number(port) });

  mqttClient.on('connect', () => {
    console.log(`✅ Terhubung ke MQTT Broker: ${broker}`);
    mqttClient.subscribe('smartac/sensor/+');
    mqttClient.subscribe('smartac/ir/+');
    mqttClient.subscribe('smartac/learning/+');
  });

  mqttClient.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const topicParts = topic.split('/');
      const deviceId = topicParts[2];

      const data = JSON.parse(message.toString());

      if (topic.startsWith('smartac/ir/') || topic.startsWith('smartac/learning/')) {
        const signal = data.signal ?? data.raw_data ?? null;

        if (signal == null) {
          console.warn(`⚠️ Payload IR tidak lengkap dari device ${deviceId}`);
          return;
        }

        const stored = await irCloneService.storeCapturedSignal({
          deviceId,
          target: data.target,
          signal
        });

        if (stored) {
          console.log(`📡 IR tersimpan dari ${deviceId} untuk target ${String(data.target).toUpperCase()}`);
        }

        return;
      }

      const suhuAktual = parseFloat(data.suhu);
      const statusKehadiran = data.kehadiran === 1 || data.kehadiran === true ? 'Ada Orang' : 'Kosong';

      if (isNaN(suhuAktual)) {
        console.warn(`⚠️ Data suhu tidak valid dari device ${deviceId}`);
        return;
      }

      const [rows] = await db.query('SELECT * FROM ruangan WHERE device_id = ?', [deviceId]);
      if (rows.length === 0) {
        return;
      }

      const room = rows[0];

      await db.query(
        'UPDATE ruangan SET suhu_aktual = ?, status_kehadiran = ? WHERE device_id = ?',
        [suhuAktual, statusKehadiran, deviceId]
      );

      io.emit('sensor:update', {
        device_id: deviceId,
        suhu_aktual: suhuAktual,
        status_kehadiran: statusKehadiran,
        status_ac: room.status_ac,
        mode_ac: room.mode_ac,
        mode_kontrol: room.mode_kontrol
      });

      if (room.mode_kontrol === 'AUTO') {
        if (statusKehadiran === 'Ada Orang') {
          if (absenceTimers[deviceId]) {
            clearTimeout(absenceTimers[deviceId]);
            delete absenceTimers[deviceId];
            console.log(`⏱️ Timer mati otomatis dibatalkan untuk ${room.nama_ruangan} (Orang kembali)`);
          }

          await acControlService.applyAutoOnAndHysteresis({
            room,
            statusKehadiran,
            suhuAktual
          });
        } else if (statusKehadiran === 'Kosong' && room.status_ac === 'ON') {
          if (!absenceTimers[deviceId]) {
            console.log(`⏱️ Ruangan ${room.nama_ruangan} kosong. Memulai timer 15 menit...`);

            absenceTimers[deviceId] = setTimeout(async () => {
              try {
                const [latestRows] = await db.query(
                  'SELECT nama_ruangan, merk_ac, status_ac, mode_kontrol, status_kehadiran, suhu_aktual, ir_learning_state, ir_learning_target, ir_power_on_code, ir_power_off_code, ir_turbo_code, ir_normal_code FROM ruangan WHERE device_id = ?',
                  [deviceId]
                );

                if (latestRows.length === 0) {
                  delete absenceTimers[deviceId];
                  return;
                }

                const latest = latestRows[0];
                const latestPresence = (latest.status_kehadiran || '').toString().toLowerCase();
                const shouldAutoOff =
                  latest.mode_kontrol === 'AUTO' &&
                  latest.status_ac === 'ON' &&
                  latestPresence === 'kosong';

                if (!shouldAutoOff) {
                  console.log(`⏭️ Auto-OFF dilewati untuk ${latest.nama_ruangan} karena kondisi berubah.`);
                  delete absenceTimers[deviceId];
                  return;
                }

                const suhuTercatat = Number.isFinite(Number(latest.suhu_aktual))
                  ? Number(latest.suhu_aktual)
                  : suhuAktual;

                mqttClient.publish(
                  `smartac/control/${deviceId}`,
                  JSON.stringify({
                    power: 'OFF',
                    merk: latest.merk_ac,
                    ir_clone: buildIrClonePayload(latest)
                  })
                );

                await db.query('UPDATE ruangan SET status_ac = ?, mode_ac = ? WHERE device_id = ?', ['OFF', 'NORMAL', deviceId]);
                await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)',
                  [deviceId, 'OFF', 'Otomatis (Kosong 15 Menit)', suhuTercatat]);
                console.log(`⚡ Aktuasi AC ${latest.nama_ruangan}: OFF - Pemicu: Otomatis (Kosong 15 Menit)`);

                io.emit('ac:update', {
                  device_id: deviceId,
                  status_ac: 'OFF',
                  mode_ac: 'NORMAL',
                  action: 'OFF',
                  pemicu: 'Otomatis (Kosong 15 Menit)'
                });

                delete absenceTimers[deviceId];
              } catch (err) {
                console.error(`Error pada timer mati otomatis ${deviceId}:`, err);
              }
            }, delayAutoOffMs);
          }
        }
      }
    } catch (err) {
      console.error('Error memproses pesan MQTT:', err);
    }
  });

  return {
    mqttClient
  };
}

module.exports = {
  createMqttService
};
