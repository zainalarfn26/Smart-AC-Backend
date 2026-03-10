require('dotenv').config();
const mqtt = require('mqtt');

// Menghubungkan simulator ke broker yang sama dengan server Express
const client = mqtt.connect(process.env.MQTT_BROKER, {
    port: process.env.MQTT_PORT
});

client.on('connect', () => {
    console.log('🤖 [SIMULATOR] ESP32 Palsu Terhubung ke Broker!');

    // ==========================================
    // SKENARIO UJI COBA (Ubah angka di sini nanti)
    // ==========================================
    const idRuangan = 1; // 1 = Lab Komputer 1 (Batas: 22°C - 26°C)
    const topikSensor = `unipma/ac/${idRuangan}/sensor`;

    const dataPalsu = {
        suhu: 28.0,       // Suhu Ruangan Saat Ini
        kehadiran: false   // true = Ada Orang, false = Kosong
    };

    // Mengubah data menjadi JSON
    const payload = JSON.stringify(dataPalsu);

    // Menembakkan data ke server
    console.log(`📤 Mengirim data ke topik: ${topikSensor} -> ${payload}`);
    client.publish(topikSensor, payload);

    // Mematikan simulator setelah mengirim (agar rapi)
    setTimeout(() => {
        client.end();
    }, 1000);
});