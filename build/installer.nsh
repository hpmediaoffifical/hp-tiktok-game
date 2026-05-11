; ============================================================
; HP Action LIVE — Custom NSIS Installer Script
; ============================================================
; Áp dụng các tinh chỉnh chuyên nghiệp lên wizard installer.
; electron-builder include file này vào installer NSIS generated.
; Doc: https://www.electron.build/configuration/nsis

; ---- Branding strings ----
!define MUI_WELCOMEPAGE_TITLE "Chào mừng đến với HP Action LIVE"
!define MUI_WELCOMEPAGE_TEXT "Trình hướng dẫn sẽ giúp bạn cài đặt HP Action LIVE — bộ công cụ tương tác realtime với khán giả TikTok LIVE.$\r$\n$\r$\nHãy đóng các ứng dụng khác trước khi tiếp tục để tránh xung đột.$\r$\n$\r$\nBấm Tiếp tục để bắt đầu."

!define MUI_LICENSEPAGE_TEXT_TOP "Vui lòng đọc kỹ Thoả thuận sử dụng dưới đây trước khi cài đặt."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Nếu bạn đồng ý với toàn bộ điều khoản, hãy bấm 'Tôi đồng ý' để tiếp tục cài đặt."
!define MUI_LICENSEPAGE_BUTTON "Tôi đồng ý"

!define MUI_DIRECTORYPAGE_TEXT_TOP "Trình cài đặt sẽ đặt HP Action LIVE vào thư mục dưới đây. Bấm 'Duyệt...' để chọn thư mục khác."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Thư mục cài đặt:"

!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Cài đặt hoàn tất"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "HP Action LIVE đã được cài đặt thành công."

!define MUI_FINISHPAGE_TITLE "Hoàn tất cài đặt"
!define MUI_FINISHPAGE_TEXT "HP Action LIVE đã sẵn sàng sử dụng.$\r$\n$\r$\nBấm 'Hoàn tất' để đóng wizard và khởi chạy ứng dụng."
!define MUI_FINISHPAGE_RUN_TEXT "Khởi chạy HP Action LIVE ngay"

; ---- Uninstaller strings ----
!define MUI_UNWELCOMEPAGE_TITLE "Gỡ cài đặt HP Action LIVE"
!define MUI_UNWELCOMEPAGE_TEXT "Trình hướng dẫn sẽ gỡ HP Action LIVE khỏi máy tính của bạn.$\r$\n$\r$\nLưu ý: Cài đặt cá nhân (key bản quyền, vị trí hũ, triggers quà...) sẽ ĐƯỢC GIỮ LẠI trong %APPDATA%. Nếu bạn cài lại sau này, các cài đặt đó sẽ tự khôi phục.$\r$\n$\r$\nBấm Tiếp tục để bắt đầu."

!define MUI_UNCONFIRMPAGE_TEXT_TOP "HP Action LIVE sẽ được gỡ khỏi thư mục:"
!define MUI_UNCONFIRMPAGE_TEXT_LOCATION "Vị trí cài đặt:"

; ---- Hooks: ghi log khi cài đặt ----
!macro customInstall
    DetailPrint "Đang cài đặt HP Action LIVE..."
    DetailPrint "Phiên bản: ${VERSION}"
    DetailPrint "Nhà phát hành: HP Media"
!macroend

!macro customUnInstall
    DetailPrint "Đang gỡ cài đặt HP Action LIVE..."
    DetailPrint "Cài đặt cá nhân được giữ lại tại %APPDATA%\\hp-action-live"
!macroend

; ---- Hook: thêm thông tin Publisher vào Add/Remove Programs ----
!macro customHeader
    !system "echo HP Action LIVE installer built > %TEMP%\\hp-build.log"
!macroend
