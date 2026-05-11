#!/usr/bin/env node
/**
 * Sinh Ed25519 keypair cho HP License Worker.
 *
 * Chạy: node keygen.js
 *
 * Output:
 *   - private-key.pem  →  upload vào Cloudflare Worker secret SIGN_PRIVATE_KEY
 *   - public-key.pem   →  embed vào server.js (app electron) để verify
 *   - public-key.txt   →  bản 1 dòng base64, dễ paste vào code
 *
 * QUAN TRỌNG:
 *   - Chỉ chạy 1 LẦN duy nhất cho dự án.
 *   - Giữ private-key.pem an toàn (KHÔNG commit lên git, KHÔNG share).
 *   - Nếu lộ private key → re-keygen + redeploy Worker + rebuild app.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

console.log('🔑 Sinh Ed25519 keypair cho HP License Worker...\n');

// Sinh keypair
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

// Export PEM
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicPem = publicKey.export({ format: 'pem', type: 'spki' });

// Public key dạng base64 raw (32 bytes) — gọn để embed vào source code
const publicRaw = publicKey.export({ format: 'der', type: 'spki' });
// SPKI DER cho Ed25519 = 44 bytes, 12 bytes header + 32 bytes pubkey
const publicKeyBytes = publicRaw.slice(12);  // tách 32 bytes pubkey thật
const publicBase64 = publicKeyBytes.toString('base64');

// Lưu file
const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'private-key.pem'), privatePem);
fs.writeFileSync(path.join(outDir, 'public-key.pem'), publicPem);
fs.writeFileSync(path.join(outDir, 'public-key.txt'),
    'Ed25519 public key (base64, 32 bytes):\n' + publicBase64 + '\n\n' +
    'PEM format (SPKI):\n' + publicPem
);

console.log('✅ Đã sinh xong keypair.\n');
console.log('📁 Files đã tạo:');
console.log('   - private-key.pem  (BÍ MẬT — upload vào Cloudflare)');
console.log('   - public-key.pem   (public, có thể commit/share)');
console.log('   - public-key.txt   (public key dạng base64 gọn)\n');

console.log('🔐 PRIVATE KEY (PEM):');
console.log('--- copy nội dung bên dưới + paste khi chạy `wrangler secret put SIGN_PRIVATE_KEY` ---');
console.log(privatePem);

console.log('🔓 PUBLIC KEY (base64, paste vào server.js):');
console.log('--- copy 1 dòng base64 dưới đây ---');
console.log(publicBase64);
console.log('---\n');

console.log('📋 Bước tiếp theo:');
console.log('   1. cd cloudflare-worker');
console.log('   2. npm install -g wrangler');
console.log('   3. wrangler login');
console.log('   4. wrangler secret put SHEET_ID         (paste Google Sheet ID)');
console.log('   5. wrangler secret put SIGN_PRIVATE_KEY (paste nội dung private-key.pem)');
console.log('   6. wrangler deploy');
console.log('   7. Copy Worker URL (vd: https://hp-license.xxx.workers.dev)');
console.log('   8. Paste vào server.js:');
console.log('        WORKER_URL = "https://hp-license.xxx.workers.dev"');
console.log('        LICENSE_PUBLIC_KEY_B64 = "' + publicBase64 + '"\n');

console.log('⚠️  GIỮ private-key.pem AN TOÀN. KHÔNG commit lên git.');
console.log('   Đã thêm vào .gitignore tự động.\n');

// Thêm vào .gitignore
const gitignorePath = path.join(outDir, '.gitignore');
const gitignoreContent = `# Ed25519 keypair — GIỮ private key BÍ MẬT
private-key.pem
public-key.pem
public-key.txt
node_modules/
.wrangler/
`;
fs.writeFileSync(gitignorePath, gitignoreContent);
console.log('✅ Đã ghi .gitignore.');
