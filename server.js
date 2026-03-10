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
        // Batalkan timer mati otomatis jika sebelumnya sempat kosong lalu ada orang lagi
        if (absenceTimers[deviceId]) {
          clearTimeout(absenceTimers[deviceId]);
          delete absenceTimers[deviceId];
          console.log(`⏱️ Timer mati otomatis dibatalkan untuk ${room.nama_ruangan} (Orang kembali)`);
        }

        // Jika AC masih mati, nyalakan
        if (room.status_ac === 'OFF') {
          mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ power: 'ON' }));
          await db.query('UPDATE ruangan SET status_ac = ? WHERE device_id = ?', ['ON', deviceId]);
          await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
            [deviceId, 'ON', 'Otomatis (Ada Orang)', suhuAktual]);
          console.log(`⚡ Aktuasi AC ${room.nama_ruangan}: ON - Pemicu: Otomatis (Ada Orang)`);
          
          room.status_ac = 'ON'; // Update variabel lokal untuk evaluasi Hysteresis di bawah
        }
      } 
      else if (statusKehadiran === 'Kosong' && room.status_ac === 'ON') {
        // Jika ruangan kosong dan belum ada timer yang berjalan, mulai timer 15 menit
        if (!absenceTimers[deviceId]) {
          console.log(`⏱️ Ruangan ${room.nama_ruangan} kosong. Memulai timer 15 menit untuk mematikan AC...`);
          
          absenceTimers[deviceId] = setTimeout(async () => {
            // Dieksekusi setelah 15 menit
            mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ power: 'OFF' }));
            await db.query('UPDATE ruangan SET status_ac = ?, mode_ac = ? WHERE device_id = ?', ['OFF', 'NORMAL', deviceId]);
            await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
              [deviceId, 'OFF', 'Otomatis (Kosong 15 Menit)', suhuAktual]);
            console.log(`⚡ Aktuasi AC ${room.nama_ruangan}: OFF - Pemicu: Otomatis (Kosong 15 Menit)`);
            
            delete absenceTimers[deviceId]; // Bersihkan memori timer
          }, DELAY_MATI_AC);
        }
      }

      // 2. LOGIKA HYSTERESIS (KONTROL MODE TURBO/NORMAL)
      // Hysteresis HANYA berjalan jika AC dalam keadaan ON dan ada orang (atau sedang masa tunggu 15 menit)
      if (room.status_ac === 'ON') {
        let modeToChange = null;
        let pemicuMode = '';

        // Asumsi ada kolom 'mode_ac' di database Anda (isi: 'TURBO' atau 'NORMAL')
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
          mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ mode: modeToChange }));
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

// API Ambil Semua Ruangan (Untuk Dashboard)
// Karena pakai SELECT *, kolom 'mode_ac' otomatis akan ikut terkirim ke Frontend
app.get('/api/devices', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM ruangan');
  res.json(rows);
});

// API Ambil Detail 1 Ruangan
app.get('/api/devices/:id', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM ruangan WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
});

// API Tambah Alat/Ruangan Baru
app.post('/api/devices', async (req, res) => {
  const { nama, device_id, batas_atas, batas_bawah } = req.body;
  await db.query('INSERT INTO ruangan (nama_ruangan, device_id, batas_atas, batas_bawah) VALUES (?, ?, ?, ?)', 
    [nama, device_id, batas_atas, batas_bawah]);
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
  
  const [rows] = await db.query('SELECT device_id, nama_ruangan FROM ruangan WHERE id = ?', [roomId]);
  const deviceId = rows[0].device_id;

  // Kirim perintah ke ESP32
  mqttClient.publish(`smartac/control/${deviceId}`, JSON.stringify({ power: status }));
  
  // Update DB (Jika dimatikan manual, kita kembalikan mode_ac ke NORMAL sebagai default)
  const modeReset = status === 'OFF' ? 'NORMAL' : 'NORMAL'; 
  await db.query('UPDATE ruangan SET status_ac = ?, mode_ac = ? WHERE id = ?', [status, modeReset, roomId]);
  
  await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
    [deviceId, status, 'Manual (Aplikasi Frontend)', 0]);

  res.json({ message: `AC ${status} secara manual` });
});

// 🔥 BARU: API Kontrol Manual MODE AC (TURBO/NORMAL)
app.post('/api/devices/:id/mode-ac', async (req, res) => {
  const { mode_ac } = req.body; // 'TURBO' atau 'NORMAL'
  const roomId = req.params.id;
  
  const [rows] = await db.query('SELECT device_id, status_ac FROM ruangan WHERE id = ?', [roomId]);
  const device = rows[0];

  // Cegah ubah mode jika AC sedang mati
  if (device.status_ac === 'OFF') {
    return res.status(400).json({ error: 'Tidak bisa mengubah mode saat AC mati' });
  }

  // Kirim perintah ke ESP32
  mqttClient.publish(`smartac/control/${device.device_id}`, JSON.stringify({ mode: mode_ac }));
  
  // Update DB & Log History
  await db.query('UPDATE ruangan SET mode_ac = ? WHERE id = ?', [mode_ac, roomId]);
  await db.query('INSERT INTO log_history (device_id, action, pemicu, suhu_tercatat) VALUES (?, ?, ?, ?)', 
    [device.device_id, `MODE ${mode_ac}`, 'Manual (Aplikasi Frontend)', 0]);

  res.json({ message: `Mode AC diubah menjadi ${mode_ac}` });
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