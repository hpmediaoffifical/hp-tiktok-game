'use strict';
/**
 * HP KEY - Cau hinh client (HP Action LIVE / tiktok-game).
 * HMAC secret KHONG hardcode o day (tranh lo khi push public repo).
 * No nam o hpkey/secret.local.js (da .gitignore) - tao file do tren may build.
 */
let local = {};
try { local = require('./secret.local'); } catch (_) {}

module.exports = {
  API_URL: 'https://hpvn.media/hpkey/api.php',
  PRODUCT: 'tiktok-game',
  HMAC_SECRET: local.HMAC_SECRET || process.env.HPKEY_HMAC || '',
  HEARTBEAT_HOURS: 24,
};
