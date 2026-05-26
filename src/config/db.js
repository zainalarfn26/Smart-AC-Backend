const mysql = require('mysql2/promise');

function createDbPool() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'db_smart_ac',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

async function testDbConnection(db) {
  try {
    await db.query('SELECT 1');
    console.log('✅ Database MySQL terhubung');
  } catch (err) {
    console.error('❌ Gagal terhubung ke database:', err.message);
  }
}

module.exports = {
  createDbPool,
  testDbConnection
};
