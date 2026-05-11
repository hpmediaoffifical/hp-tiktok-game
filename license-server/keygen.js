#!/usr/bin/env node
/**
 * Sinh Ed25519 keypair cho HP License Server.
 *
 * Chạy: node keygen.js
 *
 * Output:
 *   - private-key.pem  →  paste vào .env SIGN_PRIVATE_KEY (hoặc đường dẫn vào SIGN_PRIVATE_KEY_FILE)
 *   - public-key.pem   →  embed vào server.js (app electron) để verify
 *   - public-key.txt   →  bản 1 dòng base64, dễ paste vào LICENSE_PUBLIC_KEY_B64
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

console.log('🔑 Sinh Ed25519 keypair cho HP License Server...\n');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicPem = publicKey.export({ format: 'pem', type: 'spki' });
const publicRaw = publicKey.export({ format: 'der', type: 'spki' });
const publicKeyBytes = publicRaw.slice(12);   // tách 32 bytes pubkey từ SPKI DER
const publicBase64 = publicKeyBytes.toString('base64');

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'private-key.pem'), privatePem);
fs.writeFileSync(path.join(outDir, 'public-key.pem'), publicPem);
fs.writeFileSync(path.join(outDir, 'public-key.txt'),
    'Ed25519 public key (base64, 32 bytes):\n' + publicBase64 + '\n\n' +
    'PEM format (SPKI):\n' + publicPem
);

console.log('✅ Đã sinh xong keypair.\n');
console.log('📁 Files đã tạo:');
console.log('   - private-key.pem  (BÍ MẬT — KHÔNG commit)');
console.log('   - public-key.pem   (public)');
console.log('   - public-key.txt   (public, base64)\n');

console.log('🔓 PUBLIC KEY (base64, paste vào server.js của app electron):');
console.log('---');
console.log(publicBase64);
console.log('---\n');

console.log('📋 Cài đặt server:');
console.log('   1. cp .env.example .env');
console.log('   2. Mở .env, set:');
console.log('        SIGN_PRIVATE_KEY_FILE=./private-key.pem');
console.log('        ADMIN_TOKEN=' + crypto.randomBytes(32).toString('hex'));
console.log('        SHEET_ID=...');
console.log('   3. npm install');
console.log('   4. npm start');
console.log('   5. Server chạy ở http://localhost:8787');
console.log('   6. Admin dashboard: http://localhost:8787/admin/?token=<ADMIN_TOKEN>\n');

console.log('📋 Update app electron:');
console.log('   Mở server.js (project root), set:');
console.log('     LICENSE_WORKER_URL = "https://your-license-server.com"  // hoặc localhost:8787 khi test');
console.log('     LICENSE_PUBLIC_KEY_B64 = "' + publicBase64 + '"\n');

console.log('⚠️  GIỮ private-key.pem AN TOÀN. KHÔNG commit lên git.');
