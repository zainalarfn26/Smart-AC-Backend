function createHistoryController({ db }) {
  return {
    getHistory: async (req, res) => {
      try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;

        const [countResult] = await db.query(
          'SELECT COUNT(*) as total FROM log_history JOIN ruangan ON log_history.device_id = ruangan.device_id'
        );
        const total = countResult[0].total;

        const [rows] = await db.query(
          `SELECT log_history.*, ruangan.nama_ruangan
           FROM log_history
           JOIN ruangan ON log_history.device_id = ruangan.device_id
           ORDER BY waktu DESC
           LIMIT ? OFFSET ?`,
          [limit, offset]
        );

        res.json({
          data: rows,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          }
        });
      } catch (err) {
        console.error('Error get history:', err);
        res.status(500).json({ error: 'Gagal mengambil riwayat log.' });
      }
    }
  };
}

module.exports = {
  createHistoryController
};
