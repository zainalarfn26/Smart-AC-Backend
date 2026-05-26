const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function createAuthController({ db, jwtSecret, jwtExpiresIn }) {
  return {
    register: async (req, res) => {
      try {
        const { nama, email, password } = req.body;

        if (!nama || !email || !password) {
          return res.status(400).json({ error: 'Nama, email, dan password wajib diisi.' });
        }
        if (password.length < 6) {
          return res.status(400).json({ error: 'Password minimal 6 karakter.' });
        }

        const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
          return res.status(409).json({ error: 'Email sudah terdaftar.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.query(
          'INSERT INTO users (nama, email, password) VALUES (?, ?, ?)',
          [nama, email, hashedPassword]
        );

        const token = jwt.sign({ id: result.insertId, email }, jwtSecret, { expiresIn: jwtExpiresIn });

        res.status(201).json({
          message: 'Registrasi berhasil.',
          token,
          user: { id: result.insertId, nama, email }
        });
      } catch (err) {
        console.error('Error register:', err);
        res.status(500).json({ error: 'Gagal melakukan registrasi.' });
      }
    },

    login: async (req, res) => {
      try {
        const { email, password } = req.body;

        if (!email || !password) {
          return res.status(400).json({ error: 'Email dan password wajib diisi.' });
        }

        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) {
          return res.status(401).json({ error: 'Email atau password salah.' });
        }

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
          return res.status(401).json({ error: 'Email atau password salah.' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: jwtExpiresIn });

        res.json({
          message: 'Login berhasil.',
          token,
          user: { id: user.id, nama: user.nama, email: user.email }
        });
      } catch (err) {
        console.error('Error login:', err);
        res.status(500).json({ error: 'Gagal melakukan login.' });
      }
    },

    me: async (req, res) => {
      try {
        const [rows] = await db.query('SELECT id, nama, email FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0) {
          return res.status(404).json({ error: 'User tidak ditemukan.' });
        }
        res.json(rows[0]);
      } catch (err) {
        console.error('Error get user:', err);
        res.status(500).json({ error: 'Gagal mengambil data user.' });
      }
    }
  };
}

module.exports = {
  createAuthController
};
