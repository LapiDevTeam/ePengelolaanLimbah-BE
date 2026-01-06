const jwt = require('jsonwebtoken');

/**
 * Auth middleware yang support token dari query parameter
 * Digunakan khusus untuk endpoint yang dibuka via window.open()
 * yang tidak bisa mengirim Authorization header
 */
const authMiddlewareWithQuery = (req, res, next) => {
  let token = null;

  // 1. Coba ambil token dari Authorization header (prioritas utama)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. Jika tidak ada di header, coba ambil dari query parameter
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // 3. Jika masih tidak ada token, tolak request
  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication token required. Please provide token in Authorization header or query parameter.' 
    });
  }

  try {
    // 4. Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 5. Attach user info ke request object
    req.user = decoded.user;
    
    // Delegated User (if any)
    if (decoded.delegatedTo) {
      req.delegatedUser = decoded.delegatedTo;
    }

    // 6. Lanjutkan ke controller
    next();
  } catch (error) {
    return res.status(401).json({ 
      success: false,
      message: 'Invalid or expired token.' 
    });
  }
};

module.exports = authMiddlewareWithQuery;
