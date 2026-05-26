-- ==========================================
-- DATABASE SCHEMA: Smart AC Controller
-- Jalankan file ini di phpMyAdmin atau MySQL CLI
-- ==========================================

CREATE DATABASE IF NOT EXISTS db_smart_ac;
USE db_smart_ac;

-- ==========================================
-- Tabel Users (Autentikasi)
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nama VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ==========================================
-- Tabel Ruangan (Data AC & Sensor)
-- ==========================================
CREATE TABLE IF NOT EXISTS ruangan (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nama_ruangan VARCHAR(255) NOT NULL,
  device_id VARCHAR(100) NOT NULL UNIQUE,
  merk_ac VARCHAR(50) DEFAULT 'DAIKIN',
  batas_atas FLOAT NOT NULL DEFAULT 26.0,
  batas_bawah FLOAT NOT NULL DEFAULT 22.0,
  suhu_aktual FLOAT DEFAULT NULL,
  status_kehadiran VARCHAR(50) DEFAULT 'Kosong',
  status_ac VARCHAR(10) DEFAULT 'OFF',
  mode_ac VARCHAR(20) DEFAULT 'NORMAL',
  mode_kontrol VARCHAR(20) DEFAULT 'AUTO',
  ir_learning_target VARCHAR(20) DEFAULT NULL,
  ir_learning_state VARCHAR(20) DEFAULT 'IDLE',
  ir_power_on_code LONGTEXT DEFAULT NULL,
  ir_power_off_code LONGTEXT DEFAULT NULL,
  ir_turbo_code LONGTEXT DEFAULT NULL,
  ir_normal_code LONGTEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ==========================================
-- Tabel Log History (Riwayat Aksi)
-- ==========================================
CREATE TABLE IF NOT EXISTS log_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(100) NOT NULL,
  action VARCHAR(255) NOT NULL,
  pemicu VARCHAR(255) NOT NULL,
  suhu_tercatat FLOAT DEFAULT 0,
  waktu TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_device_id (device_id),
  INDEX idx_waktu (waktu),
  FOREIGN KEY (device_id) REFERENCES ruangan(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ==========================================
-- Data Contoh (Opsional - untuk testing)
-- ==========================================
INSERT INTO ruangan (nama_ruangan, device_id, merk_ac, batas_atas, batas_bawah) VALUES
  ('Lab Komputer 1', 'ESP32_001', 'DAIKIN', 26.0, 22.0),
  ('Ruang Dosen', 'ESP32_002', 'PANASONIC', 25.0, 21.0);
