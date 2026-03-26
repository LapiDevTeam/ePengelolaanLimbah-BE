const axios = require('axios');

const DECODE_URL =
  process.env.GLOBAL_API_URL ||
  process.env.LMS_DECODE_URL ||
  process.env.LMS_URL ||
  'http://192.168.1.38/api/lms-dev/v1/decode';

const getTokenFromHeaders = (req) => {
  const authorization = req.headers.authorization || req.headers.Authorization;
  if (authorization && authorization.startsWith('Bearer ')) {
    return authorization.split(' ')[1];
  }

  const authentication = req.headers.authentication;
  if (!authentication) return null;

  if (authentication.startsWith('Bearer ')) {
    return authentication.split(' ')[1];
  }

  return authentication;
};

const authMiddleware = async (req, res, next) => {
  const token = getTokenFromHeaders(req);
  if (!token) {
    return res.status(401).json({ message: 'Authentication token required.' });
  }

  try {
    const response = await axios.get(DECODE_URL, {
      headers: {
        access_token: token,
      },
    });
    const decoded = response && response.data ? response.data : {};

    if (!decoded?.user?.log_NIK) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }

    req.user = decoded.user;

    if (decoded.delegatedTo) {
      req.delegatedUser = decoded.delegatedTo;
    }

    next();
  } catch (error) {
    const statusCode = error?.response?.status || 500;
    if (statusCode === 401 || statusCode === 403) {
      return res.status(401).json({ message: 'Invalid or expired token.' });
    }

    return res.status(503).json({
      message: 'Unable to validate token from LMS decode service.',
    });
  }
};

module.exports = authMiddleware;