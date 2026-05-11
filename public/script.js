(function () {
    const socket = io();

    // DOM
    const $ = (sel) => document.querySelector(sel);
    const usernameInput = $('#username');
    const btnConnect = $('#btn-connect');
    const btnDisconnect = $('#btn-disconnect');
    const btnReloadGifts = $('#btn-reload-gifts');
    const btnClearComments = $('#btn-clear-comments');
    const btnClearGifts = $('#btn-clear-gifts');
    const dot = $('#dot');
    const statusText = $('#status-text');
    const viewerCount = $('#viewer-count');
    const commentsEl = $('#comments');
    const giftStreamEl = $('#gift-stream');
    const giftCatalogEl = $('#gift-catalog');
    const giftSearchInput = $('#gift-search');
    const stageEl = $('#stage');
    const stageEmpty = $('#stage-empty');

    // State
    let giftSheet = [];
    let giftMap = {};
    const placeholderImg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="%231f2533"/><text x="32" y="38" text-anchor="middle" fill="%23ff6b3d" font-size="14" font-family="Arial">QUÀ</text></svg>';

    function setStatus(state, text) {
        dot.classList.remove('online', 'connecting', 'error');
        if (state) dot.classList.add(state);
        statusText.textContent = text;
    }

    // Comments
    function appendComment(c) {
        const div = document.createElement('div');
        div.className = 'comment-item';
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (c.profilePicture) {
            const img = document.createElement('img');
            img.src = c.profilePicture;
            img.onerror = () => avatar.removeChild(img);
            avatar.appendChild(img);
        }
        const body = document.createElement('div');
        body.className = 'body';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = c.nickname || c.uniqueId || 'guest';
        const text = document.createElement('div');
        text.className = 'text';
        text.textContent = c.comment || '';
        body.appendChild(name);
        body.appendChild(text);
        div.appendChild(avatar);
        div.appendChild(body);
        commentsEl.appendChild(div);
        if (commentsEl.children.length > 200) commentsEl.removeChild(commentsEl.firstChild);
        commentsEl.scrollTop = commentsEl.scrollHeight;
    }

    function appendSystem(text) {
        const div = document.createElement('div');
        div.className = 'system-line';
        div.textContent = text;
        commentsEl.appendChild(div);
        commentsEl.scrollTop = commentsEl.scrollHeight;
    }

    // Gift events stream
    function appendGiftEvent(g) {
        const sheetItem = giftMap[String(g.giftId)];
        const item = document.createElement('div');
        item.className = 'gift-event';
        item.draggable = true;

        const dragData = {
            giftId: String(g.giftId),
            name: sheetItem?.name || g.giftName || 'Quà',
            image: sheetItem?.image || g.giftPicture || placeholderImg,
            diamond: sheetItem?.diamond ?? g.diamondCount,
            source: 'live'
        };
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/json', JSON.stringify(dragData));
            e.dataTransfer.effectAllowed = 'copy';
        });

        const img = document.createElement('img');
        img.src = dragData.image;
        img.onerror = () => { img.src = placeholderImg; };

        const info = document.createElement('div');
        info.className = 'info';
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = g.nickname || g.uniqueId || 'guest';
        const what = document.createElement('div');
        what.className = 'what';
        what.textContent = dragData.name;
        const idLine = document.createElement('div');
        idLine.className = 'id';
        idLine.textContent = `ID: ${g.giftId}` + (dragData.diamond ? ` • ${dragData.diamond}💎` : '');
        info.appendChild(who);
        info.appendChild(what);
        info.appendChild(idLine);

        const qty = document.createElement('div');
        qty.className = 'qty';
        qty.textContent = `x${g.repeatCount || 1}`;

        item.appendChild(img);
        item.appendChild(info);
        item.appendChild(qty);
        giftStreamEl.appendChild(item);
        if (giftStreamEl.children.length > 80) giftStreamEl.removeChild(giftStreamEl.firstChild);
        giftStreamEl.scrollTop = giftStreamEl.scrollHeight;
    }

    // Gift catalog from sheet
    function renderGiftCatalog(filter = '') {
        giftCatalogEl.innerHTML = '';
        const f = filter.trim().toLowerCase();
        const list = !f ? giftSheet : giftSheet.filter(g =>
            g.id.toLowerCase().includes(f) || (g.name || '').toLowerCase().includes(f)
        );
        for (const g of list) {
            const card = document.createElement('div');
            card.className = 'gift-card';
            card.draggable = true;

            const dragData = {
                giftId: g.id,
                name: g.name,
                image: g.image || placeholderImg,
                diamond: g.diamond,
                source: 'catalog'
            };
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/json', JSON.stringify(dragData));
                e.dataTransfer.effectAllowed = 'copy';
            });

            const img = document.createElement('img');
            img.loading = 'lazy';
            img.src = dragData.image;
            img.onerror = () => { img.src = placeholderImg; };

            const name = document.createElement('div');
            name.className = 'name';
            name.textContent = g.name || '';

            const idLine = document.createElement('div');
            idLine.className = 'id';
            idLine.textContent = `ID ${g.id}`;

            const dia = document.createElement('div');
            dia.className = 'diamond';
            dia.textContent = (g.diamond || 0) + ' 💎';

            card.appendChild(img);
            card.appendChild(name);
            card.appendChild(idLine);
            card.appendChild(dia);
            giftCatalogEl.appendChild(card);
        }
    }

    // Stage drag & drop
    stageEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        stageEl.classList.add('drag-over');
    });
    stageEl.addEventListener('dragleave', () => stageEl.classList.remove('drag-over'));
    stageEl.addEventListener('drop', (e) => {
        e.preventDefault();
        stageEl.classList.remove('drag-over');
        let data;
        try { data = JSON.parse(e.dataTransfer.getData('application/json')); }
        catch (err) { return; }
        if (!data) return;
        const rect = stageEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        spawnStageToken(data, x, y);
    });

    function spawnStageToken(data, x, y) {
        if (stageEmpty) stageEmpty.style.display = 'none';
        const token = document.createElement('div');
        token.className = 'stage-token';
        const w = 96, h = 110;
        token.style.left = Math.max(0, Math.min(x - w / 2, stageEl.clientWidth - w)) + 'px';
        token.style.top = Math.max(0, Math.min(y - h / 2, stageEl.clientHeight - h)) + 'px';

        const close = document.createElement('div');
        close.className = 'close-btn';
        close.textContent = '×';
        close.title = 'Xoá';
        close.addEventListener('click', () => {
            token.remove();
            if (!stageEl.querySelector('.stage-token') && stageEmpty) stageEmpty.style.display = 'flex';
        });

        const img = document.createElement('img');
        img.src = data.image || placeholderImg;
        img.onerror = () => { img.src = placeholderImg; };

        // The "auto-rename gift code -> gift ID" requirement:
        // primary label is the gift ID from sheet (column A), not the gift's name/code.
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = `ID ${data.giftId}`;

        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = data.name || '';

        token.appendChild(close);
        token.appendChild(img);
        token.appendChild(label);
        token.appendChild(sub);
        stageEl.appendChild(token);

        // Make placed token draggable around stage
        let dragging = false;
        let offX = 0, offY = 0;
        token.addEventListener('mousedown', (ev) => {
            if (ev.target === close) return;
            dragging = true;
            const r = token.getBoundingClientRect();
            offX = ev.clientX - r.left;
            offY = ev.clientY - r.top;
            token.style.zIndex = Date.now();
            ev.preventDefault();
        });
        document.addEventListener('mousemove', (ev) => {
            if (!dragging) return;
            const rect = stageEl.getBoundingClientRect();
            const nx = ev.clientX - rect.left - offX;
            const ny = ev.clientY - rect.top - offY;
            token.style.left = Math.max(0, Math.min(nx, stageEl.clientWidth - token.offsetWidth)) + 'px';
            token.style.top = Math.max(0, Math.min(ny, stageEl.clientHeight - token.offsetHeight)) + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    // Buttons
    btnConnect.addEventListener('click', async () => {
        const username = (usernameInput.value || '').trim().replace(/^@/, '');
        if (!username) { usernameInput.focus(); return; }
        btnConnect.disabled = true;
        setStatus('connecting', `Đang kết nối @${username}...`);
        try {
            const res = await fetch('/api/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'Lỗi không xác định');
            setStatus('online', `@${data.username} • room ${data.roomId}`);
            btnDisconnect.disabled = false;
            appendSystem(`Đã kết nối @${data.username} (room ${data.roomId})`);
        } catch (e) {
            setStatus('error', 'Lỗi: ' + e.message);
            btnConnect.disabled = false;
            appendSystem('Lỗi kết nối: ' + e.message);
        }
    });

    btnDisconnect.addEventListener('click', async () => {
        btnDisconnect.disabled = true;
        await fetch('/api/disconnect', { method: 'POST' });
        btnConnect.disabled = false;
        setStatus(null, 'Đã ngắt kết nối');
    });

    btnReloadGifts.addEventListener('click', async () => {
        btnReloadGifts.disabled = true;
        try {
            const res = await fetch('/api/reload-gifts', { method: 'POST' });
            const data = await res.json();
            appendSystem(data.ok ? `Đã tải ${data.count} quà từ Sheet` : `Lỗi tải Sheet: ${data.error}`);
        } finally {
            btnReloadGifts.disabled = false;
        }
    });

    btnClearComments.addEventListener('click', () => commentsEl.innerHTML = '');
    btnClearGifts.addEventListener('click', () => giftStreamEl.innerHTML = '');

    giftSearchInput.addEventListener('input', () => renderGiftCatalog(giftSearchInput.value));
    usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnConnect.click(); });

    // Socket events
    socket.on('connect', () => appendSystem('Kết nối tới server thành công.'));
    socket.on('disconnect', () => appendSystem('Mất kết nối tới server.'));

    socket.on('giftSheet', (data) => {
        giftSheet = data || [];
        giftMap = {};
        for (const g of giftSheet) giftMap[String(g.id)] = g;
        renderGiftCatalog(giftSearchInput.value);
    });

    socket.on('status', (s) => {
        if (s?.connected) {
            setStatus('online', `@${s.username || ''}` + (s.roomId ? ` • room ${s.roomId}` : ''));
            btnConnect.disabled = true;
            btnDisconnect.disabled = false;
        } else {
            setStatus(null, s?.reason === 'streamEnd' ? 'LIVE đã kết thúc' : 'Chưa kết nối');
            btnConnect.disabled = false;
            btnDisconnect.disabled = true;
        }
    });

    socket.on('error', (e) => appendSystem('Lỗi: ' + (e?.message || '')));
    socket.on('chat', appendComment);
    socket.on('gift', appendGiftEvent);
    socket.on('member', (m) => appendSystem(`👋 ${m.nickname || m.uniqueId} đã vào LIVE`));
    socket.on('social', (s) => appendSystem(`💗 ${s.nickname || s.uniqueId} ${s.label || 'social'}`));
    socket.on('roomUser', (r) => {
        if (typeof r.viewerCount === 'number') viewerCount.textContent = `👥 ${r.viewerCount}`;
    });

    setStatus(null, 'Chưa kết nối');
})();
