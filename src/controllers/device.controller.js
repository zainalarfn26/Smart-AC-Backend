const { buildIrClonePayload, normalizeIrTarget } = require('../services/ir-clone.service');

function createDeviceController({ db, mqttClient, io, absenceTimers, acControlService, irCloneService }) {
  return {
    getDevices: async (req, res) => {
      try {
        const [rows] = await db.query('SELECT * FROM ruangan');
        res.json(rows);
      } catch (err) {
        console.error('Error get devices:', err);
        res.status(500).json({ error: 'Gagal mengambil data ruangan.' });
      }
    },

    getDeviceById: async (req, res) => {
      try {
        const [rows] = await db.query('SELECT * FROM ruangan WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }
        res.json(rows[0]);
      } catch (err) {
        console.error('Error get device:', err);
        res.status(500).json({ error: 'Gagal mengambil data ruangan.' });
      }
    },

    addDevice: async (req, res) => {
      try {
        const { nama, device_id, batas_atas, batas_bawah, merk_ac = 'DAIKIN' } = req.body;

        const [existing] = await db.query('SELECT id FROM ruangan WHERE device_id = ?', [device_id]);
        if (existing.length > 0) {
          return res.status(409).json({ error: 'Device ID sudah terdaftar.' });
        }

        await db.query(
          'INSERT INTO ruangan (nama_ruangan, device_id, batas_atas, batas_bawah, merk_ac) VALUES (?, ?, ?, ?, ?)',
          [nama, device_id, batas_atas, batas_bawah, merk_ac]
        );
        res.status(201).json({ message: 'Alat berhasil ditambahkan.' });
      } catch (err) {
        console.error('Error add device:', err);
        res.status(500).json({ error: 'Gagal menambahkan alat.' });
      }
    },

    updateDevice: async (req, res) => {
      try {
        const { merk_ac, batas_atas, batas_bawah } = req.body;
        const roomId = req.params.id;

        const [check] = await db.query('SELECT id FROM ruangan WHERE id = ?', [roomId]);
        if (check.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }

        await db.query(
          'UPDATE ruangan SET merk_ac = ?, batas_atas = ?, batas_bawah = ? WHERE id = ?',
          [merk_ac, batas_atas, batas_bawah, roomId]
        );
        res.json({ message: 'Pengaturan berhasil diperbarui.' });
      } catch (err) {
        console.error('Error update device:', err);
        res.status(500).json({ error: 'Gagal memperbarui pengaturan.' });
      }
    },

    deleteDevice: async (req, res) => {
      try {
        const roomId = req.params.id;

        const [rows] = await db.query('SELECT device_id FROM ruangan WHERE id = ?', [roomId]);
        if (rows.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }

        const deviceId = rows[0].device_id;
        await db.query('DELETE FROM log_history WHERE device_id = ?', [deviceId]);
        await db.query('DELETE FROM ruangan WHERE id = ?', [roomId]);

        res.json({ message: 'Ruangan dan riwayatnya berhasil dihapus.' });
      } catch (err) {
        console.error('Error delete device:', err);
        res.status(500).json({ error: 'Gagal menghapus ruangan.' });
      }
    },

    setSystemMode: async (req, res) => {
      try {
        const { mode } = req.body;
        const roomId = req.params.id;
        const modeUpper = mode?.toUpperCase();

        const [rows] = await db.query(
          'SELECT id, device_id, nama_ruangan, merk_ac, status_ac, mode_ac, mode_kontrol, status_kehadiran, suhu_aktual, batas_atas, batas_bawah, ir_learning_state, ir_learning_target, ir_power_on_code, ir_power_off_code, ir_turbo_code, ir_normal_code FROM ruangan WHERE id = ?',
          [roomId]
        );
        if (rows.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }

        const room = rows[0];
        const deviceId = room.device_id;
        const statusKehadiran = (room.status_kehadiran || '').toString().toLowerCase();
        const suhuAktual = Number.isFinite(Number(room.suhu_aktual)) ? Number(room.suhu_aktual) : 0;

        await db.query('UPDATE ruangan SET mode_kontrol = ? WHERE id = ?', [modeUpper, roomId]);

        if (modeUpper === 'MANUAL' && absenceTimers[deviceId]) {
          clearTimeout(absenceTimers[deviceId]);
          delete absenceTimers[deviceId];
        }

        if (modeUpper === 'AUTO') {
          const normalizedPresence = statusKehadiran === 'ada orang' ? 'Ada Orang' : 'Kosong';

          await acControlService.applyAutoOnAndHysteresis({
            room,
            statusKehadiran: normalizedPresence,
            suhuAktual
          });
        }

        res.json({ message: `Mode sistem diubah menjadi ${modeUpper}` });
      } catch (err) {
        console.error('Error set mode:', err);
        res.status(500).json({ error: 'Gagal mengubah mode sistem.' });
      }
    },

    setPower: async (req, res) => {
      try {
        const { status } = req.body;
        const roomId = req.params.id;

        const [rows] = await db.query(
          'SELECT device_id, nama_ruangan, merk_ac, ir_learning_state, ir_learning_target, ir_power_on_code, ir_power_off_code, ir_turbo_code, ir_normal_code FROM ruangan WHERE id = ?',
          [roomId]
        );
        if (rows.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }

        const device = rows[0];
        const statusUpper = status.toUpperCase();
        const irClone = buildIrClonePayload(device);

        mqttClient.publish(
          `smartac/control/${device.device_id}`,
          JSON.stringify({ power: statusUpper, merk: device.merk_ac, ir_clone: irClone })
        );

        const modeReset = 'NORMAL';
        await db.query('UPDATE ruangan SET status_ac = ?, mode_ac = ? WHERE id = ?', [statusUpper, modeReset, roomId]);
        await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)',
          [device.device_id, statusUpper, 'Manual (Aplikasi Frontend)', 0]);

        io.emit('ac:update', {
          device_id: device.device_id,
          status_ac: statusUpper,
          mode_ac: modeReset,
          action: statusUpper,
          pemicu: 'Manual (Aplikasi Frontend)'
        });

        res.json({ message: `AC ${statusUpper} secara manual.` });
      } catch (err) {
        console.error('Error set power:', err);
        res.status(500).json({ error: 'Gagal mengontrol power AC.' });
      }
    },

    setAcMode: async (req, res) => {
      try {
        const { mode_ac } = req.body;
        const roomId = req.params.id;

        const [rows] = await db.query(
          'SELECT device_id, status_ac, merk_ac, ir_learning_state, ir_learning_target, ir_power_on_code, ir_power_off_code, ir_turbo_code, ir_normal_code FROM ruangan WHERE id = ?',
          [roomId]
        );
        if (rows.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }

        const device = rows[0];
        if (device.status_ac === 'OFF') {
          return res.status(400).json({ error: 'Tidak bisa mengubah mode saat AC mati.' });
        }

        const modeUpper = mode_ac.toUpperCase();
        mqttClient.publish(
          `smartac/control/${device.device_id}`,
          JSON.stringify({ mode: modeUpper, merk: device.merk_ac, ir_clone: buildIrClonePayload(device) })
        );

        await db.query('UPDATE ruangan SET mode_ac = ? WHERE id = ?', [modeUpper, roomId]);
        await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)',
          [device.device_id, `MODE ${modeUpper}`, 'Manual (Aplikasi Frontend)', 0]);

        io.emit('ac:update', {
          device_id: device.device_id,
          mode_ac: modeUpper,
          action: `MODE ${modeUpper}`,
          pemicu: 'Manual (Aplikasi Frontend)'
        });

        res.json({ message: `Mode AC diubah menjadi ${modeUpper}.` });
      } catch (err) {
        console.error('Error set mode AC:', err);
        res.status(500).json({ error: 'Gagal mengubah mode AC.' });
      }
    },

    startIrLearning: async (req, res) => {
      try {
        const roomId = req.params.id;
        const targetUpper = normalizeIrTarget(req.body.target);

        const [rows] = await db.query(
          'SELECT id, device_id, nama_ruangan, merk_ac, ir_learning_state, ir_learning_target, ir_power_on_code, ir_power_off_code, ir_turbo_code, ir_normal_code FROM ruangan WHERE id = ?',
          [roomId]
        );

        if (rows.length === 0) {
          return res.status(404).json({ error: 'Ruangan tidak ditemukan.' });
        }

        const room = rows[0];
        await irCloneService.startLearning({ room, target: targetUpper });

        await db.query(
          'INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)',
          [room.device_id, `IR LEARN ${targetUpper}`, 'Setup Cloning IR (Aplikasi Frontend)', 0]
        );

        res.json({
          message: `Mode belajar IR aktif untuk ${targetUpper}.`,
          learning_state: 'LEARNING',
          learning_target: targetUpper
        });
      } catch (err) {
        console.error('Error start IR learning:', err);
        res.status(500).json({ error: err.message || 'Gagal memulai belajar IR.' });
      }
    }
  };
}

module.exports = {
  createDeviceController
};
