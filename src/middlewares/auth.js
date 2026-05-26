const jwt = require('jsonwebtoken');

function createAuthMiddleware(jwtSecret) {
  return function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Token tidak valid atau sudah kedaluwarsa.' });
    }
  };
}

module.exports = {
  createAuthMiddleware
};
