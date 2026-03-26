const axios = require('axios');

const DECODE_URL =
  process.env.GLOBAL_API_URL ||
  process.env.LMS_DECODE_URL ||
  process.env.LMS_URL ||
  'http://192.168.1.38/api/lms-dev/v1/decode';

const getTokenFromRequest = (req) => {
  const authorization = req.headers.authorization || req.headers.Authorization;
  if (authorization && authorization.startsWith('Bearer ')) {
    return authorization.split(' ')[1];
  }

  const authentication = req.headers.authentication;
  if (authentication) {
    if (authentication.startsWith('Bearer ')) {
      return authentication.split(' ')[1];
    }
    return authentication;
  }

  if (req.query.token) {
    return req.query.token;
  }

  return null;
};

/**
 * Auth middleware yang support token dari query parameter
 * Digunakan khusus untuk endpoint yang dibuka via window.open()
 * yang tidak bisa mengirim Authorization header
 */
const authMiddlewareWithQuery = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication token required. Please provide token in Authorization header or query parameter.' 
    });
  }

  try {
    const response = await axios.get(DECODE_URL, {
      headers: {
        access_token: token,
      },
    });
    const decoded = response && response.data ? response.data : {};

    if (!decoded?.user?.log_NIK) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.'
      });
    }

    req.user = decoded.user;
    
    if (decoded.delegatedTo) {
      req.delegatedUser = decoded.delegatedTo;
    }

    next();
  } catch (error) {
    const statusCode = error?.response?.status || 500;
    if (statusCode === 401 || statusCode === 403) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.'
      });
    }

    return res.status(503).json({ 
      success: false,
      message: 'Unable to validate token from LMS decode service.' 
    });
  }
};

module.exports = authMiddlewareWithQuery;
