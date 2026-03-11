const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const mqtt = require('mqtt');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// 1. KONFIGURASI DATABASE MYSQL
// ==========================================
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',      // Sesuaikan dengan user database Anda
  password: '',      // Sesuaikan dengan password database Anda
  database: 'db_smart_ac'
});

// ==========================================
// 2. KONFIGURASI MQTT & ALGORITMA HYSTERESIS
// ==========================================
const mqttClient = mqtt.connect('mqtt://broker.emqx.io'); 

// Objek untuk menyimpan timer per device (mengatur delay 15 menit)
const absenceTimers = {}; 
const DELAY_MATI_AC = 15 * 60 * 1000; // 15 menit dalam milidetik

mqttClient.on('connect', () => {
  console.log('✅ Terhubung ke MQTT Broker');
  mqttClient.subscribe('smartac/sensor/+'); 
});

mqttClient.on('message', async (topic, message) => {
  try {
    const topicParts = topic.split('/');
    const deviceId = topicParts[2];
    
    const data = JSON.parse(message.toString());
    const suhuAktual = data.suhu;
    const statusKehadiran = data.kehadiran === 1 ? 'Ada Orang' : 'Kosong';

    const [rows] = await db.query('SELECT * FROM ruangan WHERE device_id = ?', [deviceId]);
    if (rows.length === 0) return;

    const room = rows[0];

    // Update data real-time ke DB
    await db.query('UPDATE ruangan SET suhu_aktual = ?, status_kehadiran = ? WHERE device_id = ?', 
      [suhuAktual, statusKehadiran, deviceId]);

    // ---------------------------------------------------------
    // 🔥 CORE LOGIC: RADAR (POWER) & HYSTERESIS (MODE)
    // ---------------------------------------------------------
    if (room.mode_kontrol === 'AUTO') {
      
      // 1. LOGIKA RADAR (KONTROL POWER ON/OFF)
      if (statusKehadiran === 'Ada Orang') {
        if (absenceTimers[deviceId]) {
          clearTimeout(absenceTimers[deviceId]);
          delete absenceTimers[deviceId];
          console.log(`⏱️ Timer mati otomatis dibatalkan untuk ${room.nama_ruangan} (Orang kembali)`);
        }

        if (room.status_ac === 'OFF') {
          // 👉 UPDATE: Sisipkan data merk_ac
          mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ power: 'ON', merk: room.merk_ac }));
          
          await db.query('UPDATE ruangan SET status_ac = ? WHERE device_id = ?', ['ON', deviceId]);
          await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
            [deviceId, 'ON', 'Otomatis (Ada Orang)', suhuAktual]);
          console.log(`⚡ Aktuasi AC ${room.nama_ruangan}: ON - Pemicu: Otomatis (Ada Orang)`);
          
          room.status_ac = 'ON'; 
        }
      } 
      else if (statusKehadiran === 'Kosong' && room.status_ac === 'ON') {
        if (!absenceTimers[deviceId]) {
          console.log(`⏱️ Ruangan ${room.nama_ruangan} kosong. Memulai timer 15 menit...`);
          
          absenceTimers[deviceId] = setTimeout(async () => {
            // 👉 UPDATE: Sisipkan data merk_ac
            mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ power: 'OFF', merk: room.merk_ac }));
            
            await db.query('UPDATE ruangan SET status_ac = ?, mode_ac = ? WHERE device_id = ?', ['OFF', 'NORMAL', deviceId]);
            await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
              [deviceId, 'OFF', 'Otomatis (Kosong 15 Menit)', suhuAktual]);
            console.log(`⚡ Aktuasi AC ${room.nama_ruangan}: OFF - Pemicu: Otomatis (Kosong 15 Menit)`);
            
            delete absenceTimers[deviceId]; 
          }, DELAY_MATI_AC);
        }
      }

      // 2. LOGIKA HYSTERESIS (KONTROL MODE TURBO/NORMAL)
      if (room.status_ac === 'ON') {
        let modeToChange = null;
        let pemicuMode = '';
        const currentMode = room.mode_ac || 'NORMAL'; 

        if (suhuAktual >= room.batas_atas && currentMode !== 'TURBO') {
          modeToChange = 'TURBO';
          pemicuMode = `Otomatis (Hysteresis Atas: ${suhuAktual}°C)`;
        } 
        else if (suhuAktual <= room.batas_bawah && currentMode !== 'NORMAL') {
          modeToChange = 'NORMAL';
          pemicuMode = `Otomatis (Hysteresis Bawah: ${suhuAktual}°C)`;
        }

        if (modeToChange) {
          // 👉 UPDATE: Sisipkan data merk_ac
          mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ mode: modeToChange, merk: room.merk_ac }));
          
          await db.query('UPDATE ruangan SET mode_ac = ? WHERE device_id = ?', [modeToChange, deviceId]);
          await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
            [deviceId, `MODE ${modeToChange}`, pemicuMode, suhuAktual]);
          console.log(`❄️ Ubah Mode AC ${room.nama_ruangan}: ${modeToChange} - Pemicu: ${pemicuMode}`);
        }
      }
    }

  } catch (err) {
    console.error('Error memproses pesan MQTT:', err);
  }
});

// ==========================================
// 3. REST API UNTUK APLIKASI VUE.JS (FRONTEND)
// ==========================================

// API Ambil Semua Ruangan
app.get('/api/devices', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM ruangan');
  res.json(rows);
});

// API Ambil Detail 1 Ruangan
app.get('/api/devices/:id', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM ruangan WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
});

// 👉 UPDATE: API Tambah Alat (Menambahkan field merk_ac)
app.post('/api/devices', async (req, res) => {
  // Tambahkan merk_ac dari request body. Beri default 'DAIKIN' jika kosong.
  const { nama, device_id, batas_atas, batas_bawah, merk_ac = 'DAIKIN' } = req.body;
  await db.query('INSERT INTO ruangan (nama_ruangan, device_id, batas_atas, batas_bawah, merk_ac) VALUES (?, ?, ?, ?, ?)', 
    [nama, device_id, batas_atas, batas_bawah, merk_ac]);
  res.json({ message: 'Alat berhasil ditambahkan' });
});

// API Kontrol Mode Otomatisasi (Auto/Manual)
app.post('/api/devices/:id/mode', async (req, res) => {
  const { mode } = req.body;
  await db.query('UPDATE ruangan SET mode_kontrol = ? WHERE id = ?', [mode, req.params.id]);
  res.json({ message: 'Mode sistem diubah menjadi ' + mode });
});

// API Kontrol Manual Power AC (ON/OFF)
app.post('/api/devices/:id/power', async (req, res) => {
  const { status } = req.body;
  const roomId = req.params.id;
  
  // 👉 UPDATE: Tambahkan merk_ac ke dalam SELECT
  const [rows] = await db.query('SELECT device_id, nama_ruangan, merk_ac FROM ruangan WHERE id = ?', [roomId]);
  const deviceId = rows[0].device_id;
  const merkAc = rows[0].merk_ac;

  // 👉 UPDATE: Sisipkan merk di payload MQTT
  mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ power: status, merk: merkAc }));
  
  const modeReset = status === 'OFF' ? 'NORMAL' : 'NORMAL'; 
  await db.query('UPDATE ruangan SET status_ac = ?, mode_ac = ? WHERE id = ?', [status, modeReset, roomId]);
  
  await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
    [deviceId, status, 'Manual (Aplikasi Frontend)', 0]);

  res.json({ message: `AC ${status} secara manual` });
});

// API Kontrol Manual MODE AC (TURBO/NORMAL)
app.post('/api/devices/:id/mode-ac', async (req, res) => {
  const { mode_ac } = req.body; 
  const roomId = req.params.id;
  
  // 👉 UPDATE: Tambahkan merk_ac ke dalam SELECT
  const [rows] = await db.query('SELECT device_id, status_ac, merk_ac FROM ruangan WHERE id = ?', [roomId]);
  const device = rows[0];

  if (device.status_ac === 'OFF') {
    return res.status(400).json({ error: 'Tidak bisa mengubah mode saat AC mati' });
  }

  // 👉 UPDATE: Sisipkan merk di payload MQTT
  mqttClient.publish(`smartac/control/${device.device_id}`, JSON.stringify({ mode: mode_ac, merk: device.merk_ac }));
  
  await db.query('UPDATE ruangan SET mode_ac = ? WHERE id = ?', [mode_ac, roomId]);
  await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
    [device.device_id, `MODE ${mode_ac}`, 'Manual (Aplikasi Frontend)', 0]);

  res.json({ message: `Mode AC diubah menjadi ${mode_ac}` });
});

// 🔥 BARU: API Update Pengaturan Alat (Merk AC & Hysteresis)
app.put('/api/devices/:id', async (req, res) => {
  const { merk_ac, batas_atas, batas_bawah } = req.body;
  const roomId = req.params.id;

  try {
    await db.query(
      'UPDATE ruangan SET merk_ac = ?, batas_atas = ?, batas_bawah = ? WHERE id = ?', 
      [merk_ac, batas_atas, batas_bawah, roomId]
    );
    res.json({ message: 'Pengaturan berhasil diperbarui' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal memperbarui pengaturan' });
  }
});

// API Ambil Riwayat Log
app.get('/api/history', async (req, res) => {
  const query = `
    SELECT log_history.*, ruangan.nama_ruangan 
    FROM log_history 
    JOIN ruangan ON log_history.device_id = ruangan.device_id 
    ORDER BY waktu DESC LIMIT 50
  `;
  const [rows] = await db.query(query);
  res.json(rows);
});

// Jalankan Server Express
app.listen(PORT, () => {
  console.log(`🚀 Server Backend berjalan di http://localhost:${PORT}`);
});