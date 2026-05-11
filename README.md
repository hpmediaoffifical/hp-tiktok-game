# HP TIKTOK GAME

Thư viện game tương tác với TikTok LIVE cho streamer — kết nối realtime với phòng LIVE qua [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector), chạy game vật lý trên overlay OBS, đầy đủ tính năng tương tác viewer.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-42-9feaf9)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)

## ✨ Tính năng

### Kết nối & Hiển thị
- 🔗 Kết nối phòng TikTok LIVE bằng `@username`, nhận realtime: chat, gift, member, like, social, viewer count
- 📺 Overlay OBS trong suốt 1080×1920 — dán URL vào OBS Browser Source là chạy
- 💬 Popup bình luận LIVE có badge unread (chính idol thường xem trên TikTok Studio, đây làm backup)
- 👑 Vương miện top-1 tipper trên đầu hũ
- 🏆 Bảng TOP TẶNG kéo thả mọi vị trí, resize được
- 📊 Tổng quà & 💎 sao
- 🎯 Goal Bar mục tiêu kim cương (tới 100,000)
- 👋 Welcome banner "Thắp sáng quà mới" khi quà mới xuất hiện
- 🔥 Combo streak toast cho người tặng nhiều lần liên tiếp

### Game: Hũ Thủy Tinh
- 🫙 Hũ thủy tinh với vật lý Matter.js — kéo thả vị trí bất kỳ trong vùng 1080×1920
- 🥷 Tên trộm ninja đu dây vào ăn cắp quà — 1 click = 1 tên trộm với tên user
- 🚔 Cảnh sát tóm trộm — ban per-user, có panel "BỊ TÓM" + nút "BẢO LÃNH" cho idol ân xá
- 🚓 Lực lượng cảnh sát: user tặng quà chỉ định để gia nhập đội, không thể trộm khi đã gia nhập
- 🪟 Nứt hũ tích luỹ → vỡ tan khi đủ ngưỡng (quà tràn ra stack ở đáy overlay)
- 🚚 Trộm cả hũ: ninja khổng lồ ôm hũ chạy ra rồi trả lại
- 🎆 Hiệu ứng: Pháo hoa, Megaboom, Lốc xoáy, Nghiêng, Đảo trọng lực, Lắc, Slow motion, Xoá hết
- ⛓ Combo chuỗi hiệu ứng có delay tuỳ chỉnh

### Map quà → hiệu ứng (Trigger system)
- 🎁 Chuột phải bất kỳ card quà → gán cho hiệu ứng → khi viewer tặng quà đó, effect kích hoạt
- ⚙ Modal cài đặt riêng cho từng effect (cường độ, thời gian, ngưỡng vỡ, số đường nứt…)
- 1 quà = 1 effect, tự bảo vệ chống trùng

### UX
- 🎨 UI tabs: Vật lý · Tính năng · Quà · Thử
- 💾 Auto-save mọi cài đặt vào đĩa + nút "Lưu tất cả" ngay tức thì
- ⌨ Ghi nhớ username TikTok đã kết nối lần cuối
- 🎚 Slider scale TOP TẶNG / BỊ TÓM
- 🔊 Âm thanh Web Audio (plop, ting, fanfare, big, steal)
- 📦 Đóng gói thành desktop app (Electron) — system tray + single instance + splash screen

## 🚀 Khởi chạy

```bash
# Cài deps
npm install

# Chế độ web (trình duyệt mở http://localhost:3000)
npm run server

# Chế độ desktop (Electron — recommended)
npm start
```

## 📦 Build installer

```bash
npm run build              # NSIS installer + portable
npm run build:portable     # chỉ portable .exe
```

Output ở thư mục `dist/`:
- `HP Action LIVE Setup x.x.x.exe` — installer có wizard, tạo shortcut Desktop + Start Menu
- `HP-Action-LIVE-Portable-x.x.x.exe` — bản portable, chạy không cần cài

## 🎯 Quy trình dùng cho streamer

1. **Khởi chạy app** → nhập username TikTok đang LIVE → bấm Kết nối
2. **Mở OBS** → thêm Browser Source → URL `http://localhost:3000/overlay/thuytinh`, kích thước 1080×1920
3. **Cấu hình** trong app: vào tab Quà, chuột phải vào quà bất kỳ → gán cho hiệu ứng (vd: 5655 → Trộm, 9498 → Lốc xoáy)
4. **Tinh chỉnh** physics, mục tiêu, kích thước panel theo ý
5. **LIVE thật** → khi viewer tặng quà chỉ định → effect kích hoạt với tên/avatar của viewer

## 🏗 Kiến trúc

```
electron-main.js   → Electron wrapper: server + splash + tray + single-instance
server.js          → Express + Socket.IO + TikTok bridge + Google Sheet loader
public/
  index.html       → UI chính (sidebar + tabs + game view)
  app.js           → State management, UI logic, socket events
  style.css        → Theme tối
  games/thuytinh/
    game.js        → Core game module (Matter.js, effects, stats, persistence)
    overlay.html   → Trang overlay OBS độc lập (transparent)
data/
  app-config.json  → Persist cài đặt user (license, lastUsername, configs)
```

## ⚙ Tech stack

- **Backend**: Node.js + Express + Socket.IO + tiktok-live-connector
- **Frontend**: Vanilla JS + Matter.js (physics) + Canvas API + SVG
- **Desktop**: Electron 42 + electron-builder
- **Realtime**: Socket.IO rooms (overlay / preview) + state snapshot sync
- **Persistence**: JSON file trên đĩa

## 📜 License

Internal HP Media tool. Đóng gói bằng [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector) (MIT) và [Matter.js](https://github.com/liabru/matter-js) (MIT).
