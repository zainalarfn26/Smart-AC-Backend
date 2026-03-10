require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const mqtt = require('mqtt');

// Inisialisasi Express
const app = express();
app.use(cors()); // Mengizinkan Vue.js mengakses API ini
app.use(express.json()); // Agar bisa membaca data format JSON

// ==========================================
// 1. KONEKSI DATABASE (MySQL Connection Pool)
// ==========================================
// Kita pakai 'Pool' agar server kuat menahan banyak tembakan data IoT sekaligus
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, conn) => {
    if (err) {
        console.error('❌ Gagal koneksi ke Database XAMPP:', err.message);
    } else {
        console.log('✅ [DATABASE] Terhubung ke MySQL (db_smart_ac)');
        conn.release();
    }
});

// ==========================================
// 2. KONEKSI MQTT (Broker)
// ==========================================
const mqttClient = mqtt.connect(process.env.MQTT_BROKER, {
    port: process.env.MQTT_PORT
});

mqttClient.on('connect', () => {
    console.log(`✅ [MQTT] Terhubung ke Broker (${process.env.MQTT_BROKER})`);
    
    // Server langsung men-subscribe (mendengarkan) semua laporan sensor dari ruangan manapun
    const topikSensor = 'unipma/ac/+/sensor'; 
    mqttClient.subscribe(topikSensor, (err) => {
        if (!err) {
            console.log(`✅ [MQTT] Berhasil subscribe ke topik: ${topikSensor}`);
        }
    });
});

// Event Listener: Jika ada data sensor masuk dari ESP32
mqttClient.on('message', (topic, message) => {
    // 1. Membedah Topik (Contoh: "unipma/ac/1/sensor")
    const topicParts = topic.split('/');
    
    // Pastikan ini adalah topik sensor, bukan topik lain
    if (topicParts.length !== 4 || topicParts[3] !== 'sensor') return;

    const ruanganId = topicParts[2]; // Mengambil ID Ruangan (angka 1, 2, atau 3)
    let payload;

    try {
        // Mengubah pesan JSON dari ESP32 menjadi objek JavaScript
        payload = JSON.parse(message.toString());
    } catch (e) {
        console.error('❌ Data dari ESP32 bukan format JSON yang valid');
        return;
    }

    const suhuSekarang = payload.suhu;
    const kehadiran = payload.kehadiran; // bernilai true atau false

    console.log(`\n📥 [DATA SENSOR] Ruang ID: ${ruanganId} | Suhu: ${suhuSekarang}°C | Orang: ${kehadiran ? 'Ada' : 'Kosong'}`);

    // 2. Simpan Riwayat Data Sensor ke Database
    const sqlLogSensor = 'INSERT INTO log_sensor (ruangan_id, suhu, status_kehadiran) VALUES (?, ?, ?)';
    db.query(sqlLogSensor, [ruanganId, suhuSekarang, kehadiran], (err) => {
        if (err) console.error('❌ Gagal simpan log sensor:', err.message);
    });

    // 3. Tarik Data Ruangan untuk Algoritma Hysteresis
    const sqlRuangan = 'SELECT * FROM ruangan WHERE id = ?';
    db.query(sqlRuangan, [ruanganId], (err, results) => {
        if (err || results.length === 0) return;
        
        const ruangan = results[0];
        
        // --- CEK MODE KONTROL ---
        // Jika mode MANUAL, hentikan proses otomatis. Biarkan user yang kontrol via HP.
        if (ruangan.mode_kontrol === 'MANUAL') {
            console.log(`⏸️ [MODE MANUAL] Ruangan ${ruangan.nama_ruangan} diabaikan oleh algoritma otomatis.`);
            return;
        }

        // --- ALGORITMA HYSTERESIS & KEHADIRAN ---
        let perintahBaru = null;
        let pemicu = '';

        if (kehadiran === false) {
            // Aturan 1: Ruangan Kosong -> Wajib Matikan AC (Efisiensi Energi)
            if (ruangan.status_ac_terakhir === 'ON') {
                perintahBaru = 'TURN_OFF';
                pemicu = 'Otomatis: Ruangan Kosong';
            }
        } else {
            // Aturan 2: Ruangan Ada Orang -> Gunakan Hysteresis untuk Suhu
            if (suhuSekarang >= ruangan.batas_suhu_atas && ruangan.status_ac_terakhir === 'OFF') {
                // Suhu lebih dari batas atas (misal > 26) -> Nyalakan AC
                perintahBaru = 'TURN_ON';
                pemicu = `Otomatis: Suhu Panas (${suhuSekarang}°C)`;
            } 
            else if (suhuSekarang <= ruangan.batas_suhu_bawah && ruangan.status_ac_terakhir === 'ON') {
                // Suhu kurang dari batas bawah (misal < 22) -> Matikan AC
                perintahBaru = 'TURN_OFF';
                pemicu = `Otomatis: Suhu Dingin (${suhuSekarang}°C)`;
            }
            // Jika suhu di tengah-tengah (misal 24), algoritma Hysteresis akan diam (mempertahankan status terakhir)
        }

        // --- EKSEKUSI PERINTAH ---
        // Jika algoritma memutuskan harus ada perubahan status AC
        if (perintahBaru !== null) {
            console.log(`⚙️ [HYSTERESIS AKTIF] Mengirim perintah ${perintahBaru} ke ${ruangan.nama_ruangan}`);
            
            // A. Tembak perintah balik ke ESP32 via MQTT
            const topikKontrol = `unipma/ac/${ruanganId}/kontrol`;
            const payloadKontrol = JSON.stringify({
                aksi: perintahBaru,
                merk: ruangan.merk_ac // ESP32 langsung tahu harus pakai kode remote apa!
            });
            mqttClient.publish(topikKontrol, payloadKontrol);

            // B. Update status terakhir di tabel ruangan
            const statusAcBaru = perintahBaru === 'TURN_ON' ? 'ON' : 'OFF';
            db.query('UPDATE ruangan SET status_ac_terakhir = ? WHERE id = ?', [statusAcBaru, ruanganId]);

            // C. Catat sejarah ini ke log_aktuasi agar bisa dilihat di aplikasi Mobile
            const sqlLogAktuasi = 'INSERT INTO log_aktuasi (ruangan_id, aksi_ac, pemicu) VALUES (?, ?, ?)';
            db.query(sqlLogAktuasi, [ruanganId, perintahBaru, pemicu]);
        }
    });
});

// ==========================================
// 3. PEMBUATAN REST API (Untuk Aplikasi Vue.js)
// ==========================================
// Endpoint untuk mengambil daftar ruangan dan status AC-nya
app.get('/api/ruangan', (req, res) => {
    db.query('SELECT * FROM ruangan', (err, results) => {
        if (err) {
            return res.status(500).json({ status: 'error', pesan: err.message });
        }
        res.json({
            status: 'success',
            data: results
        });
    });
});
// Endpoint untuk mengubah Mode (AUTO / MANUAL)
app.put('/api/ruangan/:id/mode', (req, res) => {
    const idRuangan = req.params.id;
    const modeBaru = req.body.mode; // 'AUTO' atau 'MANUAL'

    const sql = 'UPDATE ruangan SET mode_kontrol = ? WHERE id = ?';
    db.query(sql, [modeBaru, idRuangan], (err) => {
        if (err) return res.status(500).json({ status: 'error', pesan: err.message });
        
        console.log(`🔄 [API] Mode Ruangan ${idRuangan} diubah menjadi ${modeBaru}`);
        res.json({ status: 'success', pesan: `Mode berhasil diubah ke ${modeBaru}` });
    });
});

// Endpoint untuk menyalakan/mematikan AC secara Manual dari HP
app.post('/api/ruangan/:id/kontrol', (req, res) => {
    const idRuangan = req.params.id;
    const aksi = req.body.aksi; // 'TURN_ON' atau 'TURN_OFF'
    const merkAc = req.body.merk; 

    console.log(`📱 [API MANUAL] Perintah ${aksi} untuk Ruangan ${idRuangan} (Merk: ${merkAc})`);

    // 1. Tembak perintah ke ESP32 via MQTT
    const topikKontrol = `unipma/ac/${idRuangan}/kontrol`;
    const payloadKontrol = JSON.stringify({ aksi: aksi, merk: merkAc });
    mqttClient.publish(topikKontrol, payloadKontrol);

    // 2. Update status terakhir di database
    const statusAcBaru = aksi === 'TURN_ON' ? 'ON' : 'OFF';
    db.query('UPDATE ruangan SET status_ac_terakhir = ? WHERE id = ?', [statusAcBaru, idRuangan]);

    // 3. Catat di riwayat bahwa ini dilakukan secara manual via HP
    const sqlLogAktuasi = 'INSERT INTO log_aktuasi (ruangan_id, aksi_ac, pemicu) VALUES (?, ?, ?)';
    db.query(sqlLogAktuasi, [idRuangan, aksi, 'Manual via Aplikasi Mobile']);

    res.json({ status: 'success', pesan: `Perintah ${aksi} berhasil dikirim!` });
});

// Endpoint untuk mengambil riwayat AC per ruangan (5 data terbaru)
app.get('/api/ruangan/:id/riwayat', (req, res) => {
    const idRuangan = req.params.id;
    
    // Query SQL untuk mengambil 5 log terbaru berdasarkan ID Ruangan
    const sql = `
        SELECT aksi_ac, pemicu, waktu_eksekusi 
        FROM log_aktuasi 
        WHERE ruangan_id = ? 
        ORDER BY waktu_eksekusi DESC 
        LIMIT 5
    `;
    
    db.query(sql, [idRuangan], (err, results) => {
        if (err) {
            return res.status(500).json({ status: 'error', pesan: err.message });
        }
        res.json({ status: 'success', data: results });
    });
});
// ==========================================
// 4. JALANKAN SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 [SERVER] Backend Express.js berjalan di http://localhost:${PORT}`);
    console.log('======================================================');
});