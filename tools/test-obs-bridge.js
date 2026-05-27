#!/usr/bin/env node
// tools/test-obs-bridge.js
// Standalone test script — verify OBS bridge hoạt động.
//
// Chạy: node tools/test-obs-bridge.js [hotkeyName]
//
// Yêu cầu:
//   1. OBS Studio đang chạy
//   2. WebSocket Server đã enable (Tools → WebSocket Server Settings)
//   3. (Optional) Password — chỉnh OBS_WS_PASSWORD env var nếu cần
//   4. Lua script đã load + hotkey đã register (vd effect_chao_dap_trigger)
//
// Examples:
//   node tools/test-obs-bridge.js                              # list tất cả hotkey
//   node tools/test-obs-bridge.js effect_chao_dap_trigger      # trigger 1 effect
//   OBS_WS_PASSWORD=abc123 node tools/test-obs-bridge.js       # với password

const path = require('path');
const { OBSBridge } = require(path.join(__dirname, '..', 'lib', 'obs-bridge'));

const URL      = process.env.OBS_WS_URL      || 'ws://localhost:4455';
const PASSWORD = process.env.OBS_WS_PASSWORD || '';
const TARGET   = process.argv[2] || null;

(async () => {
  console.log('====================================');
  console.log(' OBS Bridge — Connection Test');
  console.log('====================================');
  console.log(`URL:      ${URL}`);
  console.log(`Password: ${PASSWORD ? '(set)' : '(none)'}`);
  console.log(`Target:   ${TARGET || '(list mode)'}`);
  console.log('');

  // KHÔNG dùng license-gate ở đây để test trigger trực tiếp
  const bridge = new OBSBridge({
    isLicensed: () => true,
    autoReconnect: false,
    logger: console
  });

  try {
    console.log('[1/4] Connecting...');
    await bridge.connect(URL, PASSWORD);
    console.log('      ✓ Connected\n');

    console.log('[2/4] Querying OBS version...');
    const ver = await bridge.getOBSVersion();
    if (ver) {
      console.log(`      ✓ OBS Studio: ${ver.obsVersion} (${ver.platform})`);
      console.log(`      ✓ WebSocket:  ${ver.obsWebSocketVersion}, RPC ${ver.rpcVersion}\n`);
    } else {
      console.log('      ✗ Không lấy được version\n');
    }

    console.log('[3/4] Listing registered hotkeys (lọc effect_/hp_)...');
    const hotkeys = await bridge.listHotkeys();
    const effectHotkeys = hotkeys.filter(h => /^(effect_|hp_)/i.test(h));
    if (effectHotkeys.length === 0) {
      console.log('      ⚠ Không tìm thấy hotkey nào bắt đầu bằng effect_ hoặc hp_');
      console.log('         → Check: script .lua đã load trong OBS chưa?');
      console.log(`         Tổng số hotkey trong OBS: ${hotkeys.length}`);
    } else {
      console.log(`      ✓ Tìm thấy ${effectHotkeys.length} effect hotkey:`);
      effectHotkeys.forEach(h => console.log(`         - ${h}`));
    }
    console.log('');

    if (TARGET) {
      console.log(`[4/4] Triggering hotkey: ${TARGET}`);
      const result = await bridge.triggerHotkey(TARGET);
      if (result.ok) {
        console.log('      ✓ Trigger sent OK\n');
        console.log('   → Xem OBS preview: effect đã chạy chưa?');
        console.log('   → Nếu không thấy gì: hotkey name có thể sai, dùng list ở trên để verify.');
      } else {
        console.log(`      ✗ FAIL: reason=${result.reason}${result.error ? ', error=' + result.error : ''}`);
      }
    } else {
      console.log('[4/4] Skip trigger (no target specified)');
      console.log('       → Chạy lại với tên hotkey để test:');
      console.log('         node tools/test-obs-bridge.js <hotkey_name>');
    }

    console.log('\n[*] Disconnecting...');
    await bridge.disconnect();
    console.log('    ✓ Done');
    process.exit(0);
  } catch (err) {
    console.error('\n[!] LỖI:', err.message || err);
    console.error('\nKhả năng:');
    console.error('  - OBS chưa chạy');
    console.error('  - WebSocket Server chưa enable trong OBS');
    console.error('  - Sai port (default 4455)');
    console.error('  - Sai password (set env OBS_WS_PASSWORD=...)');
    process.exit(1);
  }
})();
