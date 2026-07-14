const axios = require('axios');

const DEVLOGGER_API_BASE_URL =
  process.env.DEVLOGGER_API_BASE_URL ||
  'http://192.168.1.38/api/DevLogger/api/v1';
const APP_NAME = process.env.DEVLOGGER_APP_NAME || 'ePemusnahan Limbah BE';
const APP_ENV = process.env.NODE_ENV || 'development';
const TIMEOUT_MS = Number(process.env.DEVLOGGER_TIMEOUT_MS || 15000);
const DEVMODE_ENABLED = String(process.env.DEVLOGGER_DEVMODE || '').toLowerCase() === 'true';

const getTokenFromRequest = (req) => {
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7);
  }

  const authentication = req.headers.authentication || '';
  if (authentication && authentication.toLowerCase().startsWith('bearer ')) {
    return authentication.slice(7);
  }

  return authentication || req.headers.access_token || '';
};

const getFullUrl = (req) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}${req.originalUrl || req.url || ''}`;
};

const safeJson = (value) => {
  if (value === undefined) return undefined;

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return '[UNSERIALIZABLE]';
  }
};

const getErrorMessage = (error) => {
  const parts = [
    error?.name,
    error?.message,
    error?.parent?.message,
    error?.parent?.detail,
    error?.original?.message,
    error?.original?.detail
  ].filter(Boolean);

  return [...new Set(parts)].join(' | ') || 'Unknown backend error';
};

const buildReportPayload = (error, req, context = {}) => {
  const token = getTokenFromRequest(req);
  const actingUser = req.delegatedUser || req.user || {};

  return {
    method: req.method,
    url: getFullUrl(req),
    status_code: context.statusCode || 500,
    error_message: getErrorMessage(error),
    error_stack: error?.stack || '',
    request_body: safeJson(req.body),
    headers: safeJson(req.headers),
    userid: context.userId || actingUser.log_NIK || req.user?.log_NIK || '',
    delegatedto: req.delegatedUser?.log_NIK || req.user?.log_NIK || '',
    auth_token: token,
    save_to_db: true,
    notes: [
      `App: ${APP_NAME}`,
      `Module: ${context.module || 'Backend'}`,
      `Operation: ${context.operation || req.method + ' ' + (req.originalUrl || req.url)}`,
      `Severity: ${context.severity || 'ERROR'}`,
      `Environment: ${APP_ENV}`
    ].join(' | ')
  };
};

const reportBackendError = async (error, req, context = {}) => {
  if (!DEVLOGGER_API_BASE_URL || !req) return null;

  const token = getTokenFromRequest(req);
  const url = `${DEVLOGGER_API_BASE_URL.replace(/\/+$/, '')}/errors/report${DEVMODE_ENABLED ? '?devmode=true' : ''}`;
  const payload = buildReportPayload(error, req, context);

  try {
    const response = await axios.post(url, payload, {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {
          authentication: token,
          Authorization: `Bearer ${token}`
        } : {})
      }
    });

    return response.data;
  } catch (reportError) {
    console.warn(
      '[DevLogger] Failed to report backend error:',
      reportError?.response?.data?.message || reportError.message
    );
    return null;
  }
};

const getReportId = (reportResult) => {
  return reportResult?.data?.id || reportResult?.id || null;
};

const reportAndBuildErrorResponse = async (error, req, context = {}) => {
  const reportResult = await reportBackendError(error, req, context);
  const reportId = getReportId(reportResult);

  return {
    error_report_id: reportId,
    error_reported: Boolean(reportId)
  };
};

const sendLoggedErrorResponse = async (res, error, req, context = {}) => {
  const statusCode = context.statusCode || 500;
  const message = context.message || 'Internal server error';
  const errorReport = await reportAndBuildErrorResponse(error, req, {
    ...context,
    statusCode
  });

  return res.status(statusCode).json({
    message,
    error: error?.message,
    ...errorReport
  });
};

module.exports = {
  reportBackendError,
  reportAndBuildErrorResponse,
  sendLoggedErrorResponse,
  buildReportPayload,
  getErrorMessage
};
