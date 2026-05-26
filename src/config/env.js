const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://broker.emqx.io';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);

function parseCorsOrigins(value) {
  const raw = (value || '*').trim();
  if (raw === '*') {
    return '*';
  }

  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : '*';
}

const CORS_ORIGIN = parseCorsOrigins(process.env.CORS_ORIGIN);

function validateProductionEnv() {
  const isProduction = NODE_ENV === 'production';
  if (!isProduction) {
    return;
  }

  if (!JWT_SECRET || JWT_SECRET.length < 16) {
    throw new Error('JWT_SECRET wajib diisi minimal 16 karakter saat production.');
  }

  const blockedSecrets = [
    'smart-ac-secret-key-ganti-di-production',
    'smart-ac-dev-secret-key-2026',
    'GANTI_DENGAN_SECRET_KEY_YANG_KUAT_DAN_RANDOM'
  ];

  if (blockedSecrets.includes(JWT_SECRET)) {
    throw new Error('JWT_SECRET tidak boleh pakai nilai default/contoh saat production.');
  }

  if (CORS_ORIGIN === '*') {
    throw new Error('CORS_ORIGIN tidak boleh wildcard (*) saat production.');
  }
}

validateProductionEnv();

module.exports = {
  NODE_ENV,
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  CORS_ORIGIN,
  MQTT_BROKER,
  MQTT_PORT
};
