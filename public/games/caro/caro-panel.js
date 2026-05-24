/* ============================================================
   HP Caro LIVE — App-side panel controller
   ============================================================
   Khởi tạo khi user mở view-caro trong app.
   Bridge giữa:
     - HpGame.caro engine (đặt quân, undo, win-detect)
     - Server (POST state/config/cmd → broadcast tới OBS)
     - TikTok comments + gifts (socket events)

   Expose: window.HpCaroPanel.open()  // gọi từ app.js openGame('caro')
   ============================================================ */
(function () {
    'use strict';

    let game = null;       // HpGame.caro instance
    let socket = null;     // shared io() — reuse từ app.js
    let initialized = false;
    let cfg = null;
    let pendingSave = null;
    let opponentSource = '';  // 'reg' (qua ghi danh) hoặc 'freeid' (nhập tay)
    const giftPickers = {};  // { reg: GiftPicker, undo: GiftPicker }
    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    // ============ SoundManager — Web Audio synth ============
    // Sinh tone bằng OscillatorNode, không cần file audio asset.
    // Creator (side='idol') = pitch cao + fanfare thắng / triangle.
    // User (side='user') = pitch thấp / khi User thắng → Creator THUA → sad descending.
    const SoundManager = {
        ctx: null,
        ensureCtx() {
            if (this.ctx) return this.ctx;
            try {
                const Ctor = window.AudioContext || window.webkitAudioContext;
                if (Ctor) this.ctx = new Ctor();
            } catch (e) { /* unsupported */ }
            return this.ctx;
        },
        // Tone helper: 1 nốt với envelope ADSR đơn giản.
        tone(ctx, freq, t, dur, vol, type = 'sine') {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            osc.type = type;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(vol, t + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(t); osc.stop(t + dur + 0.05);
        },
        play(kind, side) {
            if (!cfg?.audio?.enabled) return;
            const ctx = this.ensureCtx();
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume();
            const vol = Math.max(0, Math.min(1, (cfg.audio.volume ?? 50) / 100));
            if (vol === 0) return;

            const now = ctx.currentTime;
            if (kind === 'place') {
                if (side === 'idol') this.tone(ctx, 880, now, 0.14, 0.25 * vol, 'sine');
                else this.tone(ctx, 440, now, 0.14, 0.25 * vol, 'triangle');
            }
            else if (kind === 'win') {
                if (side === 'idol') {
                    // CREATOR THẮNG — Fanfare ascending major (C5/E5/G5 + high C)
                    [523, 659, 784, 1047].forEach((f, i) => {
                        this.tone(ctx, f, now + i * 0.09, 0.32, 0.3 * vol, 'sine');
                    });
                    // Layer triangle ngân vang dưới
                    this.tone(ctx, 261, now, 0.6, 0.18 * vol, 'triangle');
                } else {
                    // CREATOR THUA (User thắng) — Sad descending minor (E4/C4/A3/E3)
                    [659, 523, 440, 330, 220].forEach((f, i) => {
                        this.tone(ctx, f, now + i * 0.14, 0.45, 0.28 * vol, 'triangle');
                    });
                    // Layer sub bass
                    this.tone(ctx, 110, now + 0.3, 0.8, 0.15 * vol, 'sine');
                }
            }
            else if (kind === 'draw') {
                [440, 392].forEach((f, i) => this.tone(ctx, f, now + i * 0.18, 0.28, 0.25 * vol, 'sine'));
            }
            else if (kind === 'hint-yes') {
                // Cảnh báo "có thể thua" — 2 hồi chuông khẩn cấp
                [880, 1175].forEach((f, i) => this.tone(ctx, f, now + i * 0.12, 0.25, 0.3 * vol, 'square'));
            }
            else if (kind === 'hint-no') {
                // Yên tâm — 1 nốt êm dịu
                this.tone(ctx, 523, now, 0.4, 0.2 * vol, 'sine');
            }
            // === CROWD REACTIONS — noise-based, mô phỏng tiếng đám đông ===
            else if (kind === 'crowd-gasp') {
                // "Ooooh" — gấp đôi noise dải tần cao, rồi rớt
                this.crowdNoise(ctx, now, 0.6, 800, 4, 0.18 * vol, 'gasp');
            }
            else if (kind === 'crowd-cheer') {
                // "Yeahhhh" — noise burst dài + chord nền
                this.crowdNoise(ctx, now, 1.2, 600, 2, 0.22 * vol, 'cheer');
                // Layer chord vui
                [523, 659, 784].forEach(f => this.tone(ctx, f, now + 0.05, 0.5, 0.12 * vol, 'sine'));
            }
            else if (kind === 'crowd-mutter') {
                // Mutter — low murmur cho hoà / không khí
                this.crowdNoise(ctx, now, 0.8, 200, 2, 0.12 * vol, 'mutter');
            }
        },
        // Crowd noise helper — bandpass filter trên noise buffer
        crowdNoise(ctx, t, dur, freqCenter, q, vol, style) {
            // Tạo noise buffer 2 giây nếu chưa có
            if (!this._noiseBuf) {
                const len = ctx.sampleRate * 2;
                this._noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
                const data = this._noiseBuf.getChannelData(0);
                for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
            }
            const src = ctx.createBufferSource();
            src.buffer = this._noiseBuf;
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = freqCenter;
            filter.Q.value = q;
            // Pitch envelope theo style
            if (style === 'gasp') {
                filter.frequency.setValueAtTime(freqCenter * 0.7, t);
                filter.frequency.exponentialRampToValueAtTime(freqCenter * 1.5, t + dur * 0.3);
                filter.frequency.exponentialRampToValueAtTime(freqCenter * 0.8, t + dur);
            } else if (style === 'cheer') {
                filter.frequency.setValueAtTime(freqCenter, t);
                filter.frequency.exponentialRampToValueAtTime(freqCenter * 1.4, t + 0.15);
            }
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(vol, t + 0.05);
            gain.gain.linearRampToValueAtTime(vol * 0.9, t + dur * 0.7);
            gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
            src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
            src.start(t); src.stop(t + dur + 0.1);
        }
    };

    // ============ Banned-words cache — fetch từ server 1 lần khi init Caro ============
    // Dùng để lọc tên user trong TTS (không đọc tên chứa từ cấm thành tiếng).
    const BannedWords = {
        list: [],          // lowercase + non-diacritic
        loaded: false,
        loading: null,
        async load() {
            if (this.loaded) return this.list;
            if (this.loading) return this.loading;
            this.loading = fetch('/api/comment-rules/list')
                .then(r => r.json())
                .then(d => {
                    const raw = Array.isArray(d.forbiddenWords) ? d.forbiddenWords : [];
                    this.list = raw.map(w => this._normalize(w)).filter(w => w.length >= 2);
                    this.loaded = true;
                    console.log('[banned] loaded', this.list.length, 'words');
                    return this.list;
                })
                .catch(e => { console.warn('[banned] load fail:', e.message); return []; });
            return this.loading;
        },
        _normalize(s) {
            return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
                .toLowerCase().replace(/\s+/g, '').trim();
        },
        // Trả về true nếu text chứa bất kỳ từ cấm nào (đã normalize, bỏ dấu)
        contains(text) {
            if (!this.loaded || !text) return false;
            const norm = this._normalize(text);
            if (!norm) return false;
            for (const w of this.list) {
                if (norm.includes(w)) return true;
            }
            return false;
        }
    };
    BannedWords.load();   // fire-and-forget khi panel load

    // ============ TTSAnnouncer — đọc tiếng Việt qua Google TTS proxy (server) ============
    // Web Speech API không có giọng tiếng Việt mặc định trên Windows.
    // Server đã có /api/live-translate/tts proxy Google TTS → dùng nó để có giọng VN thật.
    // Fallback Web Speech nếu Google TTS fail.
    const TTSAnnouncer = {
        currentAudio: null,
        voices: [],
        ensureVoices() {
            if (!('speechSynthesis' in window)) return [];
            this.voices = window.speechSynthesis.getVoices();
            return this.voices;
        },
        viVoices() {
            this.ensureVoices();
            return this.voices.filter(v => v.lang.toLowerCase().startsWith('vi'));
        },
        // === Convert name (tùy nameMode) — bỏ qua tên cấm ===
        // side: 'idol' | 'user'
        // nickname: tên gốc (có thể chứa từ cấm)
        // Trả về { text, skip } — nếu skip=true thì gọi-bên dùng fallback moveOnly
        resolveName(side, nickname) {
            const mode = cfg?.tts?.nameMode || 'team';
            // moveOnly = không đọc tên (return empty → caller bỏ qua)
            if (mode === 'moveOnly') return { text: '', skip: true };
            // team = đọc TEAM A / TEAM B (an toàn, không lộ tên cấm)
            if (mode === 'team') {
                return { text: side === 'idol' ? 'TEAM A' : 'TEAM B', skip: false };
            }
            // full = đọc tên thật, NHƯNG check từ cấm nếu filterBannedNames bật
            const safeName = String(nickname || '').trim() || (side === 'idol' ? 'TEAM A' : 'TEAM B');
            if (cfg?.tts?.filterBannedNames !== false && BannedWords.contains(safeName)) {
                console.log('[tts] tên có từ cấm, fallback TEAM:', safeName);
                return { text: side === 'idol' ? 'TEAM A' : 'TEAM B', skip: false };
            }
            return { text: safeName, skip: false };
        },
        speak(text) {
            if (!cfg?.tts?.enabled) return;
            if (!text || !text.trim()) return;
            // Stop audio cũ
            if (this.currentAudio) {
                try { this.currentAudio.pause(); } catch {}
                this.currentAudio = null;
            }
            // Voice = '' hoặc 'google' → dùng Google TTS proxy (tiếng Việt chuẩn)
            const voiceName = cfg.tts?.voice || '';
            const useGoogle = !voiceName || voiceName === 'google';
            if (useGoogle) {
                const lang = cfg.tts?.lang || 'vi';
                const url = `/api/live-translate/tts?lang=${lang}&text=${encodeURIComponent(text)}`;
                try {
                    const audio = new Audio(url);
                    audio.volume = Math.max(0, Math.min(1, (cfg.tts.volume ?? 80) / 100));
                    audio.playbackRate = Math.max(0.5, Math.min(2.0, cfg.tts.rate ?? 1.0));
                    this.currentAudio = audio;
                    audio.play().catch(e => {
                        console.warn('[tts] Google fail, fallback Web Speech:', e.message);
                        this._speakWebSpeech(text);
                    });
                } catch (e) {
                    this._speakWebSpeech(text);
                }
            } else {
                this._speakWebSpeech(text);
            }
        },
        _speakWebSpeech(text) {
            if (!('speechSynthesis' in window)) return;
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            u.lang = 'vi-VN';
            u.volume = Math.max(0, Math.min(1, (cfg.tts.volume ?? 80) / 100));
            u.rate = Math.max(0.5, Math.min(2.0, cfg.tts.rate ?? 1.1));
            this.ensureVoices();
            const matchedVoice = cfg.tts.voice
                ? this.voices.find(v => v.name === cfg.tts.voice)
                : this.viVoices()[0];
            if (matchedVoice) u.voice = matchedVoice;
            window.speechSynthesis.speak(u);
        }
    };

    // ============ MatchEndMusic — phát nhạc khi kết thúc trận ============
    const MatchEndMusic = {
        currentAudio: null,
        play(url) {
            this.stop();
            if (!url) return;
            try {
                this.currentAudio = new Audio(url);
                const vol = Math.max(0, Math.min(1, (cfg?.audio?.volume ?? 50) / 100));
                this.currentAudio.volume = vol;
                this.currentAudio.play().catch(e => console.warn('[match-end-music] fail:', e.message));
            } catch (e) {}
        },
        stop() {
            if (this.currentAudio) {
                try { this.currentAudio.pause(); } catch {}
                this.currentAudio = null;
            }
        }
    };
    // ============ TenseMusic — phát loop khi 1 bên gần thắng (open-3/4) ============
    const TenseMusic = {
        audio: null,
        active: false,
        currentUrl: '',
        start(url) {
            if (!url) {
                console.warn('[tense-music] no url set');
                return;
            }
            // Đã đang phát URL này → skip
            if (this.active && this.currentUrl === url && this.audio && !this.audio.paused) return;
            this.stop();   // Stop nếu URL đổi
            try {
                this.audio = new Audio(url);
                this.audio.loop = true;
                const vol = Math.max(0, Math.min(1, (cfg?.music?.volume ?? 30) / 100));
                this.audio.volume = vol;
                this.currentUrl = url;
                this.audio.play().then(() => {
                    this.active = true;
                    console.log('[tense-music] playing:', url);
                }).catch(e => {
                    console.warn('[tense-music] play fail (browser autoplay block?):', e.message);
                    this.active = false;
                });
            } catch (e) {
                console.warn('[tense-music] err:', e.message);
            }
        },
        stop() {
            if (this.audio) {
                try { this.audio.pause(); this.audio.currentTime = 0; } catch {}
                this.audio = null;
            }
            this.active = false;
        }
    };

    // ============ SfxClipPlayer — HTML5 Audio cho user-uploaded clips ============
    const SfxClipPlayer = {
        currentAudio: null,
        play(url, onEnd) {
            this.stop();
            try {
                this.currentAudio = new Audio(url);
                const sfxVol = Math.max(0, Math.min(1, (cfg?.audio?.volume ?? 50) / 100));
                this.currentAudio.volume = sfxVol;
                this.currentAudio.play().catch(e => console.warn('[sfx-clip] play fail:', e.message));
                this.currentAudio.onended = () => { onEnd && onEnd(); this.currentAudio = null; };
            } catch (e) { console.warn('[sfx-clip] err:', e.message); }
        },
        stop() {
            if (this.currentAudio) {
                try { this.currentAudio.pause(); } catch {}
                this.currentAudio = null;
            }
        }
    };
    function renderSfxClips() {
        const host = document.getElementById('caro-sfx-clips');
        if (!host) return;
        const clips = cfg?.audio?.clips || [];
        host.innerHTML = '';
        if (!clips.length) {
            host.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.35);padding:4px 0;">Chưa có clip nào</div>';
            return;
        }
        clips.forEach((clip, idx) => {
            const row = document.createElement('div');
            row.className = 'caro-sfx-clip';
            row.innerHTML = `
                <button class="caro-sfx-clip-play" data-idx="${idx}" title="${escapeHtml(clip.url)}">▶ ${escapeHtml(clip.name || 'Clip ' + (idx + 1))}</button>
                <button class="caro-sfx-clip-del" data-idx="${idx}" title="Xoá clip">✕</button>`;
            host.appendChild(row);
        });
        host.querySelectorAll('.caro-sfx-clip-play').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.idx;
                const clip = (cfg?.audio?.clips || [])[idx];
                if (!clip) return;
                // Toggle visual + play
                document.querySelectorAll('.caro-sfx-clip-play.playing').forEach(b => b.classList.remove('playing'));
                btn.classList.add('playing');
                SfxClipPlayer.play(clip.url, () => btn.classList.remove('playing'));
            });
        });
        host.querySelectorAll('.caro-sfx-clip-del').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.idx;
                const clips = [...(cfg?.audio?.clips || [])];
                clips.splice(idx, 1);
                cfg.audio = { ...(cfg.audio || {}), clips };
                if (game) game.setConfig(cfg);
                clearTimeout(pendingSave);
                pendingSave = setTimeout(() => saveConfig().catch(() => {}), 500);
                renderSfxClips();
            });
        });
    }

    // ============ BackgroundMusic — Web Audio synth ambient + HTML5 Audio cho URL/file user ============
    // 3 track ambient procedural KHÔNG cần asset bundle. Cộng option user upload MP3 riêng.
    const BackgroundMusic = {
        ctx: null,
        masterGain: null,
        scheduler: null,
        playing: false,
        currentTrack: 'none',
        nextNoteTime: 0,
        step: 0,
        // User custom audio (file/URL)
        audioEl: null,
        ensureCtx() {
            if (this.ctx) return this.ctx;
            try {
                const Ctor = window.AudioContext || window.webkitAudioContext;
                if (Ctor) {
                    this.ctx = new Ctor();
                    this.masterGain = this.ctx.createGain();
                    this.masterGain.gain.value = 0.3;
                    this.masterGain.connect(this.ctx.destination);
                }
            } catch (e) {}
            return this.ctx;
        },
        setVolume(v) {
            const ctx = this.ensureCtx();
            if (this.masterGain) this.masterGain.gain.value = Math.max(0, Math.min(1, v / 100)) * 0.5;
            if (this.audioEl) this.audioEl.volume = Math.max(0, Math.min(1, v / 100));
        },
        // === Track 1: "Calm Strategy" — slow arpeggio Cmaj7 (C-E-G-B)
        track_calm(ctx, t) {
            const seq = [261.63, 329.63, 392.00, 493.88];
            const note = seq[this.step % seq.length];
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'triangle';
            o.frequency.value = note;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.18, t + 0.05);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
            o.connect(g); g.connect(this.masterGain);
            o.start(t); o.stop(t + 1.0);
            // Bass note mỗi 4 bước
            if (this.step % 4 === 0) {
                const b = ctx.createOscillator();
                const bg = ctx.createGain();
                b.type = 'sine';
                b.frequency.value = 65.41;   // C2
                bg.gain.setValueAtTime(0, t);
                bg.gain.linearRampToValueAtTime(0.25, t + 0.08);
                bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
                b.connect(bg); bg.connect(this.masterGain);
                b.start(t); b.stop(t + 1.6);
            }
            return 0.42;   // step duration
        },
        // === Track 2: "Arcade Tension" — chiptune 8-bit feel
        track_arcade(ctx, t) {
            const lead = [392, 392, 523, 392, 587, 523, 440, 440, 523, 440, 587, 659];
            const note = lead[this.step % lead.length];
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'square';
            o.frequency.value = note;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.13, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
            o.connect(g); g.connect(this.masterGain);
            o.start(t); o.stop(t + 0.2);
            // Kick mỗi bước chẵn
            if (this.step % 2 === 0) {
                const k = ctx.createOscillator();
                const kg = ctx.createGain();
                k.type = 'sine';
                k.frequency.setValueAtTime(120, t);
                k.frequency.exponentialRampToValueAtTime(40, t + 0.1);
                kg.gain.setValueAtTime(0.25, t);
                kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
                k.connect(kg); kg.connect(this.masterGain);
                k.start(t); k.stop(t + 0.13);
            }
            return 0.22;
        },
        // === Track 3: "Epic Boss" — dark sweeping pad + bass pulse
        track_epic(ctx, t) {
            const bass = [82.41, 82.41, 110, 92.5, 82.41, 82.41, 110, 123.47];   // E2/A2/F#2/B2
            const noteB = bass[this.step % bass.length];
            const b = ctx.createOscillator();
            const bg = ctx.createGain();
            b.type = 'sawtooth';
            b.frequency.value = noteB;
            bg.gain.setValueAtTime(0, t);
            bg.gain.linearRampToValueAtTime(0.22, t + 0.05);
            bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
            b.connect(bg); bg.connect(this.masterGain);
            b.start(t); b.stop(t + 0.7);
            // Pad hợp âm 4 bước/lần
            if (this.step % 4 === 0) {
                const pad = [329.63, 392, 493.88, 659.26];   // Emin7
                pad.forEach((f, i) => {
                    const o = ctx.createOscillator();
                    const g = ctx.createGain();
                    o.type = 'triangle';
                    o.frequency.value = f;
                    o.detune.value = (i - 1.5) * 8;
                    g.gain.setValueAtTime(0, t);
                    g.gain.linearRampToValueAtTime(0.1, t + 0.4);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
                    o.connect(g); g.connect(this.masterGain);
                    o.start(t); o.stop(t + 2.9);
                });
            }
            return 0.36;
        },
        // === Track 4: "Lofi Chill" — gentle pads + soft kicks
        track_lofi(ctx, t) {
            const seq = [261.63, 311.13, 349.23, 311.13];   // C/Eb/F/Eb
            const note = seq[this.step % seq.length];
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = note;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.16, t + 0.2);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
            o.connect(g); g.connect(this.masterGain);
            o.start(t); o.stop(t + 1.9);
            return 0.7;
        },
        // === Track 5: "Final Round" — fast tense rhythm
        track_final(ctx, t) {
            const rhythm = [440, 0, 440, 523, 0, 440, 587, 440];
            const note = rhythm[this.step % rhythm.length];
            if (note > 0) {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type = 'sawtooth';
                o.frequency.value = note;
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.16, t + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
                o.connect(g); g.connect(this.masterGain);
                o.start(t); o.stop(t + 0.15);
            }
            // Kick mỗi 2 step
            if (this.step % 2 === 0) {
                const k = ctx.createOscillator();
                const kg = ctx.createGain();
                k.type = 'sine';
                k.frequency.setValueAtTime(80, t);
                k.frequency.exponentialRampToValueAtTime(35, t + 0.08);
                kg.gain.setValueAtTime(0.28, t);
                kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
                k.connect(kg); kg.connect(this.masterGain);
                k.start(t); k.stop(t + 0.12);
            }
            return 0.16;
        },
        play(trackId) {
            this.stop();
            this.currentTrack = trackId || 'none';
            if (this.currentTrack === 'none') return;
            // === Custom URL/file (HTML5 Audio) ===
            if (this.currentTrack === 'custom') {
                const url = cfg?.music?.customUrl;
                if (!url) return;
                this.audioEl = new Audio(url);
                this.audioEl.loop = true;
                this.audioEl.volume = Math.max(0, Math.min(1, (cfg?.music?.volume ?? 30) / 100));
                this.audioEl.play().catch(e => console.warn('[music] play fail:', e.message));
                this.playing = true;
                return;
            }
            // === Procedural Web Audio tracks ===
            const ctx = this.ensureCtx();
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume();
            this.setVolume(cfg?.music?.volume ?? 30);
            this.step = 0;
            this.nextNoteTime = ctx.currentTime + 0.05;
            this.playing = true;
            const fn = {
                calm: this.track_calm.bind(this),
                arcade: this.track_arcade.bind(this),
                epic: this.track_epic.bind(this),
                lofi: this.track_lofi.bind(this),
                final: this.track_final.bind(this)
            }[this.currentTrack];
            if (!fn) return;
            const tick = () => {
                if (!this.playing) return;
                while (this.nextNoteTime < ctx.currentTime + 0.1) {
                    const dur = fn(ctx, this.nextNoteTime);
                    this.nextNoteTime += dur;
                    this.step++;
                }
                this.scheduler = setTimeout(tick, 50);
            };
            tick();
        },
        stop() {
            this.playing = false;
            if (this.scheduler) { clearTimeout(this.scheduler); this.scheduler = null; }
            if (this.audioEl) {
                try { this.audioEl.pause(); } catch {}
                this.audioEl = null;
            }
            this.step = 0;
        }
    };
    const MUSIC_TRACKS = [
        { id: 'none',   label: '— Không nhạc —' },
        { id: 'calm',   label: '🧘 Calm Strategy (suy nghĩ chiến thuật)' },
        { id: 'arcade', label: '🕹 Arcade Tension (8-bit nhiệt huyết)' },
        { id: 'epic',   label: '⚔️ Epic Boss (trận quyết đấu)' },
        { id: 'lofi',   label: '☕ Lofi Chill (thư giãn)' },
        { id: 'final',  label: '🔥 Final Round (cân não cuối hiệp)' },
        { id: 'custom', label: '🔗 Nhạc tự chọn (URL/file)' }
    ];

    // ============ Custom Gift Picker (thay cho <select>) ============
    function createGiftPicker(host, onChange) {
        host.innerHTML = `
            <div class="cgp">
                <button type="button" class="cgp-trigger">
                    <span class="cgp-current">
                        <span class="cgp-placeholder">— Chọn quà —</span>
                    </span>
                    <span class="cgp-clear" title="Bỏ chọn quà này">✕</span>
                    <span class="cgp-arrow">▾</span>
                </button>
                <div class="cgp-pop">
                    <input class="cgp-search" placeholder="🔍 Tìm tên quà..." />
                    <div class="cgp-list"></div>
                </div>
            </div>`;
        const root = host.querySelector('.cgp');
        const trigger = host.querySelector('.cgp-trigger');
        const pop = host.querySelector('.cgp-pop');
        const search = host.querySelector('.cgp-search');
        const list = host.querySelector('.cgp-list');
        const current = host.querySelector('.cgp-current');
        const clearBtn = host.querySelector('.cgp-clear');
        let allGifts = [];
        let selectedId = '';

        // Nút ✕ — bỏ chọn quà (stopPropagation để không mở dropdown)
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            choose('');
        });

        function render(filter) {
            const f = (filter || '').toLowerCase().trim();
            const items = !f ? allGifts
                : allGifts.filter(g => (g.name || '').toLowerCase().includes(f) || (g.id || '').toString().includes(f));
            list.innerHTML = '';
            // Hàng "Bỏ chọn" — sticky, rõ ràng
            const none = document.createElement('div');
            none.className = 'cgp-row cgp-row-none' + (selectedId === '' ? ' active' : '');
            none.innerHTML = `<span class="cgp-icon none">✕</span><span class="cgp-name">— Bỏ chọn quà —</span>`;
            none.addEventListener('click', () => choose(''));
            list.appendChild(none);
            items.forEach(g => {
                const row = document.createElement('div');
                row.className = 'cgp-row' + (selectedId === String(g.id) ? ' active' : '');
                const img = g.image ? `<img class="cgp-icon" src="${escapeHtml(g.image)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cgp-icon none',textContent:'🎁'}))" alt="" />`
                    : `<span class="cgp-icon none">🎁</span>`;
                row.innerHTML = `${img}<span class="cgp-name">${escapeHtml(g.name || g.id)}</span><span class="cgp-dia">${g.diamond || 0}💎</span>`;
                row.addEventListener('click', () => choose(String(g.id)));
                list.appendChild(row);
            });
            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'cgp-empty';
                empty.textContent = 'Không tìm thấy quà';
                list.appendChild(empty);
            }
        }

        function renderCurrent() {
            if (!selectedId) {
                current.innerHTML = `<span class="cgp-placeholder">— Chọn quà —</span>`;
                clearBtn.classList.remove('show');
                return;
            }
            const g = allGifts.find(x => String(x.id) === selectedId);
            if (!g) {
                current.innerHTML = `<span class="cgp-placeholder">— Quà không tồn tại —</span>`;
                clearBtn.classList.add('show');
                return;
            }
            const img = g.image ? `<img class="cgp-icon" src="${escapeHtml(g.image)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cgp-icon none',textContent:'🎁'}))" alt="" />`
                : `<span class="cgp-icon none">🎁</span>`;
            current.innerHTML = `${img}<span class="cgp-name">${escapeHtml(g.name || g.id)}</span><span class="cgp-dia">${g.diamond || 0}💎</span>`;
            clearBtn.classList.add('show');
        }

        function choose(id) {
            selectedId = id;
            renderCurrent();
            close();
            if (typeof onChange === 'function') onChange(id);
        }

        function positionPopup() {
            // .cgp-pop dùng position:fixed nên cần JS đặt top/left khớp trigger.
            const r = trigger.getBoundingClientRect();
            const popH = Math.min(400, window.innerHeight - r.bottom - 12);
            pop.style.left = r.left + 'px';
            pop.style.width = r.width + 'px';
            // Nếu chỗ dưới quá ít → mở lên trên trigger
            if (window.innerHeight - r.bottom < 200 && r.top > 240) {
                pop.style.top = '';
                pop.style.bottom = (window.innerHeight - r.top + 4) + 'px';
                pop.style.maxHeight = Math.min(400, r.top - 12) + 'px';
            } else {
                pop.style.bottom = '';
                pop.style.top = (r.bottom + 4) + 'px';
                pop.style.maxHeight = Math.max(220, popH) + 'px';
            }
        }
        function open() {
            pop.classList.add('show');
            root.classList.add('open');
            search.value = '';
            render('');
            positionPopup();
            setTimeout(() => search.focus(), 30);
        }
        function close() {
            pop.classList.remove('show');
            root.classList.remove('open');
        }
        // Re-position khi scroll/resize trong lúc dropdown mở.
        window.addEventListener('scroll', () => { if (isOpen()) positionPopup(); }, true);
        window.addEventListener('resize', () => { if (isOpen()) positionPopup(); });
        function isOpen() { return pop.classList.contains('show'); }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isOpen()) open(); else close();
        });
        search.addEventListener('input', () => render(search.value));
        document.addEventListener('click', (e) => {
            if (!root.contains(e.target)) close();
        });

        return {
            setList(list) { allGifts = list || []; render(search.value || ''); renderCurrent(); },
            setValue(id) { selectedId = id || ''; renderCurrent(); },
            getValue() { return selectedId; }
        };
    }

    // ---------- Public API ----------
    window.HpCaroPanel = {
        async open(sharedSocket) {
            socket = sharedSocket || window.io();
            if (!initialized) await init();
            // hiển thị view
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            $('#view-caro')?.classList.add('active');
            // Re-sync UI mỗi lần mở panel → button states không bị stuck từ lần trước
            updateUI();
            // fit canvas resize
            requestAnimationFrame(() => game && fitCanvasContainer());
            // Auto-fetch Creator avatar nếu avatar mode đang bật + có username TikTok đã typed
            maybeFetchCreatorAvatar();
        },
        instance() { return game; }
    };

    // ---------- Init ----------
    async function init() {
        // Fetch config
        try {
            const r = await fetch('/api/games/caro/config');
            cfg = await r.json();
        } catch (e) { cfg = HpGame.caro.defaultConfig(); }

        // Create game instance bound to preview canvas
        const canvas = $('#caro-canvas');
        game = HpGame.caro.create({
            canvas,
            mirrorMode: false,
            config: cfg
        });

        // Canvas tap → đặt quân
        game.on('tap', (ev) => {
            if (!ev.cell) return;
            // === CHẾ ĐỘ CHƠI THỬ — bypass mọi check, đặt luân phiên 2 màu ===
            if (cfg && cfg.practiceMode) {
                const result = game.practicePlace(ev.cell.c, ev.cell.r);
                if (!result.ok) flashWarn(translateReason(result.reason));
                else pushState();
                return;
            }
            // === WALL PLACING — Creator click ô để đặt tường ===
            const stWall = game.getState();
            if (stWall.walls?.phase === 'placing') {
                const res = game.wallPlace(ev.cell.c, ev.cell.r, 'creator-click');
                if (res.ok) {
                    const remaining = stWall.walls.target - stWall.walls.cells.length - 1;
                    logSystem(`🧱 CREATOR đặt tường tại ${ev.cell.c+1}${String.fromCharCode(65+ev.cell.r)} · còn ${remaining}`);
                    pushState();
                } else {
                    flashWarn(`Wall fail: ${res.reason}`);
                }
                return;
            }
            // === Mode chính thức: chỉ Idol mới tap, cần đúng phase ===
            const st = game.getState();
            if (st.phase !== 'playing') {
                flashWarn('Chưa vào pha chơi — bật "🧪 CHƠI THỬ" hoặc mở ghi danh & chọn đối thủ');
                return;
            }
            if (st.round.turn !== 'idol') {
                flashWarn('Chưa tới lượt CREATOR');
                return;
            }
            const result = game.placeStone(ev.cell.c, ev.cell.r, 'idol');
            if (!result.ok) flashWarn(translateReason(result.reason));
            else pushState();
        });
        // Notification sau khi đặt quân (idol hoặc user) — log
        game.on('placed', (ev) => {
            logMove(ev.side, ev.cell);
        });
        // Âm thanh phân biệt 2 màu
        game.on('sound', (ev) => {
            SoundManager.play(ev.kind, ev.side);
        });
        // Bàn đầy → popup hỏi Idol
        game.on('draw', (ev) => {
            showDrawModal(ev.isPractice);
        });
        game.on('change', () => {
            updateUI();
            // Auto-play music khi vào pha playing — auto-stop khi matchEnd
            if (cfg?.music?.enabled && cfg?.music?.autoPlayOnRound !== false) {
                const ph = game.getState().phase;
                if (ph === 'playing' && !BackgroundMusic.playing) {
                    BackgroundMusic.play(cfg.music.track || 'calm');
                } else if (ph === 'matchEnd' && BackgroundMusic.playing) {
                    BackgroundMusic.stop();
                }
            }
        });
        game.on('win', (info) => {
            const winnerName = info.side === 'idol' ? 'TEAM A' : (game.getState().opponent?.nickname || 'TEAM B');
            logSystem(`🏆 ${winnerName} thắng!`);
            pushState();
            // TTS announce — tùy nameMode (full / moveOnly / team)
            if (cfg?.tts?.enabled && cfg?.tts?.events?.win) {
                const nm = TTSAnnouncer.resolveName(info.side, winnerName);
                if (nm.text) TTSAnnouncer.speak(`${nm.text} thắng hiệp này`);
                else TTSAnnouncer.speak('Hết hiệp');
            }
            // Stop tense music + play match-end music + crowd cheer
            TenseMusic.stop();
            if (cfg?.crowd?.enabled) SoundManager.play('crowd-cheer');
            const isCreatorWin = info.side === 'idol';
            const customUrl = isCreatorWin ? cfg?.audio?.winMusic : cfg?.audio?.loseMusic;
            if (customUrl) {
                BackgroundMusic.stop();
                MatchEndMusic.play(customUrl);
            }
            // Nếu không có file custom → SoundManager đã fire qua fire('sound', {kind: 'win'}) ở placeStone
        });
        // Draw event (bàn đầy) → play draw music nếu có
        game.on('draw', (info) => {
            TenseMusic.stop();
            if (cfg?.audio?.drawMusic) {
                BackgroundMusic.stop();
                MatchEndMusic.play(cfg.audio.drawMusic);
            }
        });
        // Sau MỖI nước → check tense threat, start/stop nhạc gay cấn + crowd reaction
        let _lastThreatYes = false;
        game.on('placed', () => {
            // Tense music
            if (cfg?.tenseMusic?.enabled && cfg?.tenseMusic?.url) {
                const threat = game.checkAnyThreat();
                if (threat.yes) TenseMusic.start(cfg.tenseMusic.url);
                else TenseMusic.stop();
            }
            // Crowd "ooooh" gasp khi MỚI XUẤT HIỆN threat (transition no→yes)
            if (cfg?.crowd?.enabled || cfg?.tts?.enabled) {
                const threat = game.checkAnyThreat();
                if (threat.yes && !_lastThreatYes) {
                    if (cfg?.crowd?.enabled) SoundManager.play('crowd-gasp');
                    if (cfg?.tts?.enabled && cfg?.tts?.events?.threat) {
                        TTSAnnouncer.speak('Cẩn thận! Sắp thua rồi');
                    }
                }
                _lastThreatYes = threat.yes;
            }
            // TTS đọc nước cờ (optional, mặc định off vì spam)
            if (cfg?.tts?.enabled && cfg?.tts?.events?.move) {
                const st = game.getState();
                const last = st.round.moves[st.round.moves.length - 1];
                if (last) {
                    const rawName = last.side === 'idol' ? 'TEAM A' : (st.opponent?.nickname || 'TEAM B');
                    const nm = TTSAnnouncer.resolveName(last.side, rawName);
                    const coord = `${last.c + 1} ${String.fromCharCode(65 + last.r)}`;
                    if (nm.text) TTSAnnouncer.speak(`${nm.text} đặt ${coord}`);
                    else TTSAnnouncer.speak(`đặt ${coord}`);   // moveOnly mode
                }
            }
        });
        // Hint event — fire khi banner show AND clear → đẩy state lên overlay đồng bộ
        game.on('hint', (info) => {
            pushState();
        });

        // Wire UI (do once)
        wireSetupTab();
        wireMatchTab();
        wireUndoTab();
        wireTabs();
        wireCopyOverlay();
        wireSave();

        // Listen socket events
        bindSocket();

        // Fill gift selects from giftSheet (cached in window if app.js set)
        refreshGiftOptions();

        // Initial UI sync
        applyConfigToUI();
        updateUI();

        // canvas auto-fit
        window.addEventListener('resize', () => game && fitCanvasContainer());
        requestAnimationFrame(fitCanvasContainer);

        initialized = true;
    }

    function fitCanvasContainer() {
        const frame = $('#caro-stage-frame');
        const canvas = $('#caro-canvas');
        if (!frame || !canvas) return;
        const fw = frame.clientWidth, fh = frame.clientHeight;
        const ratio = 1080 / 1920;
        let w, h;
        if (fw / fh > ratio) { h = fh; w = h * ratio; }
        else { w = fw; h = w / ratio; }
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
    }

    // ---------- Tabs ----------
    function wireTabs() {
        const card = $('#view-caro .caro-card');
        const tabs = $$('[data-caro-tab]', card);
        const panes = $$('[data-caro-pane]', card);
        tabs.forEach(t => t.addEventListener('click', () => {
            tabs.forEach(x => x.classList.toggle('active', x === t));
            const id = t.dataset.caroTab;
            panes.forEach(p => p.classList.toggle('active', p.dataset.caroPane === id));
        }));
        // Sub-tabs trong Cấu hình
        wireSubTabs();
    }
    function wireSubTabs() {
        const setupPane = $('[data-caro-pane="setup"]');
        if (!setupPane) return;
        const subTabs = $$('.caro-subtab', setupPane);
        const accs = $$('[data-sub]', setupPane);
        const showSub = (subId) => {
            subTabs.forEach(t => t.classList.toggle('active', t.dataset.caroSubtab === subId));
            accs.forEach(a => {
                if (a.dataset.sub === subId) a.setAttribute('data-sub-active', '');
                else a.removeAttribute('data-sub-active');
            });
        };
        subTabs.forEach(t => t.addEventListener('click', () => showSub(t.dataset.caroSubtab)));
        // Default: basic
        showSub('basic');
    }

    // ---------- Setup tab ----------
    function wireSetupTab() {
        const cols = $('#caro-cols'), colsV = $('#caro-cols-v');
        const rows = $('#caro-rows'), rowsV = $('#caro-rows-v');
        const scale = $('#caro-scale'), scaleV = $('#caro-scale-v');
        cols.addEventListener('input', () => {
            colsV.textContent = cols.value;
            updateCfg({ board: { cols: +cols.value } });
            // Sync winLength + active button khi clamp tự động
            cfg.board.winLength = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
            selectSegValue('#caro-winlen-seg', cfg.board.winLength);
            updateWinLenButtons();
        });
        rows.addEventListener('input', () => {
            rowsV.textContent = rows.value;
            updateCfg({ board: { rows: +rows.value } });
            cfg.board.winLength = Math.max(3, Math.min(cfg.board.winLength, Math.min(cfg.board.cols, cfg.board.rows)));
            selectSegValue('#caro-winlen-seg', cfg.board.winLength);
            updateWinLenButtons();
        });
        scale.addEventListener('input', () => { scaleV.textContent = scale.value + '%'; updateCfg({ display: { scale: +scale.value } }); });

        wireSeg('#caro-winlen-seg', (v) => updateCfg({ board: { winLength: +v } }));
        wireSeg('#caro-bo-seg', (v) => updateCfg({ match: { bestOf: +v } }));
        wireSeg('#caro-first-seg', (v) => updateCfg({ match: { idolFirst: v === 'idol' } }));

        $('#caro-alternate-first').addEventListener('change', (e) => {
            updateCfg({ match: { alternateFirst: e.target.checked } });
        });
        $('#caro-show-history').addEventListener('change', (e) => {
            updateCfg({ display: { showHistory: e.target.checked } });
        });
        // Cell hints
        $('#caro-cell-hints').addEventListener('change', (e) => {
            updateCfg({ display: { cellHints: e.target.checked } });
        });
        const cellHintOp = $('#caro-cell-hint-op'), cellHintOpV = $('#caro-cell-hint-op-v');
        cellHintOp.addEventListener('input', () => {
            cellHintOpV.textContent = cellHintOp.value + '%';
            updateCfg({ display: { cellHintOpacity: +cellHintOp.value } });
        });
        // Audio
        $('#caro-audio-enabled').addEventListener('change', (e) => {
            updateCfg({ audio: { enabled: e.target.checked } });
            if (e.target.checked) SoundManager.play('place', 'idol'); // test sound
        });
        const audioVol = $('#caro-audio-volume'), audioVolV = $('#caro-audio-volume-v');
        audioVol.addEventListener('input', () => {
            audioVolV.textContent = audioVol.value + '%';
            updateCfg({ audio: { volume: +audioVol.value } });
        });
        audioVol.addEventListener('change', () => {
            // play test khi thả slider
            SoundManager.play('place', 'user');
        });
        // === Manual SFX test buttons (như SoundEffects) ===
        $('#caro-sfx-win-creator')?.addEventListener('click', () => SoundManager.play('win', 'idol'));
        $('#caro-sfx-lose-creator')?.addEventListener('click', () => SoundManager.play('win', 'user'));   // user thắng = creator thua
        $('#caro-sfx-draw')?.addEventListener('click', () => SoundManager.play('draw'));
        $('#caro-sfx-gasp')?.addEventListener('click', () => SoundManager.play('crowd-gasp'));
        $('#caro-sfx-cheer')?.addEventListener('click', () => SoundManager.play('crowd-cheer'));
        $('#caro-crowd-enabled')?.addEventListener('change', (e) => {
            updateCfg({ crowd: { enabled: e.target.checked } });
        });

        // === TTS Voice Announcer wiring ===
        $('#caro-tts-enabled')?.addEventListener('change', (e) => {
            updateCfg({ tts: { enabled: e.target.checked } });
        });
        // Name mode segmented (team / full / moveOnly)
        const nameModeSeg = document.getElementById('caro-tts-namemode-seg');
        if (nameModeSeg) {
            nameModeSeg.querySelectorAll('.caro-seg-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const mode = btn.dataset.v;
                    nameModeSeg.querySelectorAll('.caro-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                    updateCfg({ tts: { nameMode: mode } });
                });
            });
        }
        $('#caro-tts-filter-banned')?.addEventListener('change', (e) => {
            updateCfg({ tts: { filterBannedNames: e.target.checked } });
        });
        const ttsRate = $('#caro-tts-rate'), ttsRateV = $('#caro-tts-rate-v');
        ttsRate?.addEventListener('input', () => {
            ttsRateV.textContent = ttsRate.value + 'x';
            updateCfg({ tts: { rate: +ttsRate.value } });
        });
        const ttsVol = $('#caro-tts-volume'), ttsVolV = $('#caro-tts-volume-v');
        ttsVol?.addEventListener('input', () => {
            ttsVolV.textContent = ttsVol.value + '%';
            updateCfg({ tts: { volume: +ttsVol.value } });
        });
        $('#caro-tts-voice')?.addEventListener('change', (e) => {
            updateCfg({ tts: { voice: e.target.value } });
        });
        ['win', 'round', 'threat', 'move'].forEach(evt => {
            $(`#caro-tts-evt-${evt}`)?.addEventListener('change', (e) => {
                const events = {};
                events[evt === 'round' ? 'roundStart' : evt] = e.target.checked;
                updateCfg({ tts: { events } });
            });
        });
        $('#caro-tts-test')?.addEventListener('click', () => {
            TTSAnnouncer.speak('Xin chào, đây là giọng đọc tự động của Caro');
        });
        // Populate voice select khi voice list load (async trên 1 số browser)
        // QUAN TRỌNG: luôn thêm option "🇻🇳 Tiếng Việt (Google TTS)" ở đầu — đây là giọng VN thật,
        // không cần OS có voice VN. value='' (rỗng) = Google TTS mặc định.
        const populateTTSVoices = () => {
            const sel = $('#caro-tts-voice');
            if (!sel) return;
            const voices = TTSAnnouncer.ensureVoices();
            const vi = voices.filter(v => v.lang.toLowerCase().startsWith('vi'));
            const others = voices.filter(v => !v.lang.toLowerCase().startsWith('vi')).slice(0, 30);
            sel.innerHTML = '';
            // 1) Google TTS — mặc định + ưu tiên
            const gOpt = document.createElement('option');
            gOpt.value = '';   // empty = use Google TTS proxy
            gOpt.textContent = '🇻🇳 Tiếng Việt (Google TTS) — mặc định';
            sel.appendChild(gOpt);
            // 2) Web Speech voices VN (nếu OS có)
            const addOpt = (v, group) => {
                const opt = document.createElement('option');
                opt.value = v.name;
                opt.textContent = `${group} · ${v.name} (${v.lang})`;
                sel.appendChild(opt);
            };
            vi.forEach(v => addOpt(v, '🇻🇳 VN'));
            // 3) Voice ngoại
            others.forEach(v => addOpt(v, '🌐'));
            // Default = Google TTS nếu config chưa có voice
            sel.value = cfg?.tts?.voice || '';
        };
        populateTTSVoices();
        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = populateTTSVoices;
        }

        // === Match-end music (Win / Lose / Draw) — chọn file từ máy ===
        const wireMatchEndMusic = (kind) => {
            const key = kind === 'win' ? 'winMusic' : kind === 'lose' ? 'loseMusic' : 'drawMusic';
            const picker = $(`#caro-music-${kind}-picker`);
            const currentEl = $(`#caro-music-${kind}-current`);
            const testBtn = $(`#caro-music-${kind}-test`);
            const clearBtn = $(`#caro-music-${kind}-clear`);
            const updateCurrentDisplay = () => {
                const url = cfg?.audio?.[key] || '';
                if (currentEl) {
                    currentEl.textContent = url
                        ? `🎵 ${decodeURIComponent(url.split('/').pop().split('\\').pop())}`
                        : `— Mặc định (${kind === 'win' ? 'Web Audio fanfare' : kind === 'lose' ? 'Web Audio sad' : 'Web Audio chord'})`;
                }
            };
            picker?.addEventListener('change', (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const url = file.path ? `file:///${file.path.replace(/\\/g, '/')}` : URL.createObjectURL(file);
                cfg.audio = { ...(cfg.audio || {}), [key]: url };
                if (game) game.setConfig(cfg);
                clearTimeout(pendingSave);
                pendingSave = setTimeout(() => saveConfig().catch(() => {}), 500);
                updateCurrentDisplay();
                flashOk(`Đã set nhạc ${kind}: ${file.name}`);
                e.target.value = '';
            });
            testBtn?.addEventListener('click', () => {
                const url = cfg?.audio?.[key];
                if (url) {
                    MatchEndMusic.play(url);
                } else {
                    // Fallback to Web Audio default
                    SoundManager.play(kind === 'draw' ? 'draw' : 'win', kind === 'lose' ? 'user' : 'idol');
                }
            });
            clearBtn?.addEventListener('click', () => {
                cfg.audio = { ...(cfg.audio || {}), [key]: '' };
                if (game) game.setConfig(cfg);
                clearTimeout(pendingSave);
                pendingSave = setTimeout(() => saveConfig().catch(() => {}), 500);
                updateCurrentDisplay();
                MatchEndMusic.stop();
                flashOk(`${kind} → quay lại Web Audio mặc định`);
            });
            updateCurrentDisplay();
        };
        wireMatchEndMusic('win');
        wireMatchEndMusic('lose');
        wireMatchEndMusic('draw');

        // === Nhạc gay cấn ===
        const tenseCurrentEl = $('#caro-tense-current');
        const updateTenseCurrent = () => {
            const url = cfg?.tenseMusic?.url || '';
            if (tenseCurrentEl) {
                tenseCurrentEl.textContent = url
                    ? `🎵 ${decodeURIComponent(url.split('/').pop().split('\\').pop())}`
                    : '— Chưa chọn file';
            }
        };
        $('#caro-tense-enabled')?.addEventListener('change', (e) => {
            updateCfg({ tenseMusic: { enabled: e.target.checked } });
            if (!e.target.checked) TenseMusic.stop();
        });
        $('#caro-tense-picker')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const url = file.path ? `file:///${file.path.replace(/\\/g, '/')}` : URL.createObjectURL(file);
            updateCfg({ tenseMusic: { url } });
            updateTenseCurrent();
            flashOk(`Nhạc gay cấn: ${file.name}`);
            e.target.value = '';
        });
        $('#caro-tense-test')?.addEventListener('click', () => {
            const url = cfg?.tenseMusic?.url;
            if (!url) { flashWarn('Chưa chọn file nhạc gay cấn'); return; }
            TenseMusic.start(url);
            // Auto-stop sau 5s khi test
            setTimeout(() => TenseMusic.stop(), 5000);
        });
        $('#caro-tense-clear')?.addEventListener('click', () => {
            updateCfg({ tenseMusic: { url: '' } });
            updateTenseCurrent();
            TenseMusic.stop();
        });

        // === Custom SFX clips (user upload) ===
        const sfxClipPicker = $('#caro-sfx-clip-picker');
        sfxClipPicker?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            const existing = [...(cfg.audio?.clips || [])];
            for (const file of files) {
                const url = file.path ? `file:///${file.path.replace(/\\/g, '/')}` : URL.createObjectURL(file);
                existing.push({ name: file.name.replace(/\.(mp3|wav|ogg|m4a)$/i, ''), url });
            }
            // Trick để gán array trực tiếp (deepMerge merge object, không thay array gốc)
            cfg.audio = { ...(cfg.audio || {}), clips: existing };
            if (game) game.setConfig(cfg);
            clearTimeout(pendingSave);
            pendingSave = setTimeout(() => saveConfig().catch(() => {}), 500);
            renderSfxClips();
            flashOk(`Đã thêm ${files.length} âm thanh`);
            e.target.value = '';   // cho phép pick lại cùng file
        });
        // (renderSfxClips() được gọi từ applyConfigToUI)

        // === Music UI ===
        const musicSel = $('#caro-music-track');
        const musicCustomRow = $('#caro-music-custom-row');
        const musicCustomUrl = $('#caro-music-custom-url');
        const musicVol = $('#caro-music-volume'), musicVolV = $('#caro-music-volume-v');
        // Populate dropdown
        if (musicSel) {
            musicSel.innerHTML = MUSIC_TRACKS.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
        }
        $('#caro-music-enabled')?.addEventListener('change', (e) => {
            updateCfg({ music: { enabled: e.target.checked } });
            if (!e.target.checked) BackgroundMusic.stop();
        });
        musicSel?.addEventListener('change', (e) => {
            const track = e.target.value;
            updateCfg({ music: { track } });
            musicCustomRow.style.display = track === 'custom' ? '' : 'none';
            // Đang phát → đổi ngay
            if (BackgroundMusic.playing) BackgroundMusic.play(track);
        });
        musicCustomUrl?.addEventListener('change', (e) => {
            updateCfg({ music: { customUrl: e.target.value.trim() } });
            if (BackgroundMusic.playing && cfg.music?.track === 'custom') BackgroundMusic.play('custom');
        });
        musicVol?.addEventListener('input', () => {
            musicVolV.textContent = musicVol.value + '%';
            updateCfg({ music: { volume: +musicVol.value } });
            BackgroundMusic.setVolume(+musicVol.value);
        });
        $('#caro-music-autoplay')?.addEventListener('change', (e) => {
            updateCfg({ music: { autoPlayOnRound: e.target.checked } });
        });
        $('#caro-music-play')?.addEventListener('click', () => {
            const track = cfg?.music?.track || 'calm';
            BackgroundMusic.play(track);
            flashOk(`Đang phát: ${MUSIC_TRACKS.find(t => t.id === track)?.label || track}`);
        });
        $('#caro-music-stop')?.addEventListener('click', () => {
            BackgroundMusic.stop();
        });
        // File picker cho nhạc: chọn file local → save object URL hoặc file path (Electron)
        $('#caro-music-file-picker')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            // Electron file.path là path tuyệt đối trên disk (Browser sandbox không có)
            const urlVal = file.path ? `file:///${file.path.replace(/\\/g, '/')}` : URL.createObjectURL(file);
            $('#caro-music-custom-url').value = urlVal;
            updateCfg({ music: { customUrl: urlVal, track: 'custom' } });
            $('#caro-music-track').value = 'custom';
            $('#caro-music-custom-row').style.display = '';
            BackgroundMusic.play('custom');
            flashOk(`Đang phát: ${file.name}`);
        });

        // === Luật hôm nay — banner config ===
        $('#caro-dailyrule-enabled')?.addEventListener('change', (e) => {
            updateCfg({ dailyRule: { enabled: e.target.checked } });
        });
        $('#caro-dailyrule-preset')?.addEventListener('change', (e) => {
            const v = e.target.value;
            if (v) {
                updateCfg({ dailyRule: { text: v } });
                $('#caro-dailyrule-text').value = v;
            }
        });
        $('#caro-dailyrule-text')?.addEventListener('change', (e) => {
            updateCfg({ dailyRule: { text: e.target.value.trim() } });
        });

        // === Sương mù (fog of war) — config wiring ===
        $('#caro-fog-enabled')?.addEventListener('change', (e) => {
            updateCfg({ fogOfWar: { enabled: e.target.checked } });
        });
        const fogCount = $('#caro-fog-count'), fogCountV = $('#caro-fog-count-v');
        fogCount?.addEventListener('input', () => {
            fogCountV.textContent = fogCount.value;
            updateCfg({ fogOfWar: { visibleCount: +fogCount.value } });
        });
        wireSeg('#caro-fog-mode-seg', (v) => {
            updateCfg({ fogOfWar: { mode: v } });
            const giftRow = $('#caro-fog-gift-row');
            if (giftRow) giftRow.style.display = v === 'gift' ? '' : 'none';
        });
        if ($('#caro-fog-gift')) {
            giftPickers.fog = createGiftPicker($('#caro-fog-gift'), (id) => {
                updateCfg({ fogOfWar: { giftId: id } });
            });
        }
        // Update fog count max theo board size (board/2)
        const updateFogMax = () => {
            const max = Math.floor((cfg.board?.cols || 12) * (cfg.board?.rows || 12) / 2);
            const fc = $('#caro-fog-count');
            if (fc) fc.max = max;
        };
        updateFogMax();

        // === Tường chắn — config wiring ===
        $('#caro-walls-enabled')?.addEventListener('change', (e) => {
            updateCfg({ walls: { enabled: e.target.checked } });
        });
        const wallsCount = $('#caro-walls-count'), wallsCountV = $('#caro-walls-count-v');
        wallsCount?.addEventListener('input', () => {
            wallsCountV.textContent = wallsCount.value;
            updateCfg({ walls: { count: +wallsCount.value } });
        });
        if ($('#caro-walls-gift')) {
            giftPickers.walls = createGiftPicker($('#caro-walls-gift'), (id) => {
                updateCfg({ walls: { giftId: id } });
            });
        }
        // === Wall TEST mode — Creator preview layout không cần opponent/quà ===
        $('#caro-walls-test-start')?.addEventListener('click', () => {
            if (!game) return;
            if (cfg.walls?.enabled !== true) {
                flashWarn('Bật "Tường chắn" trước khi test');
                return;
            }
            const res = game.wallTestStart();
            if (res?.ok) {
                $('#caro-walls-test-start').disabled = true;
                $('#caro-walls-test-end').disabled = false;
                logSystem(`🧪 Test tường: click trên bàn để đặt ${cfg.walls.count} tường`);
                flashOk('Test mode ON — click trên bàn cờ');
            }
        });
        $('#caro-walls-test-end')?.addEventListener('click', () => {
            if (!game) return;
            game.wallTestEnd();
            $('#caro-walls-test-start').disabled = false;
            $('#caro-walls-test-end').disabled = true;
            logSystem('🧪 Test tường: đã xoá tất cả tường thử');
            flashOk('Đã xoá tường test');
        });
        // Khi walls vào phase 'test-done' (đủ N tường) → enable nút xoá, disable nút bắt đầu
        game.on('walls', (info) => {
            if (info.phase === 'test-done') {
                $('#caro-walls-test-start') && ($('#caro-walls-test-start').disabled = true);
                $('#caro-walls-test-end') && ($('#caro-walls-test-end').disabled = false);
                logSystem(`🧪 Test xong: đã đặt ${info.cells?.length || 0} tường`);
                flashOk('Test xong — bấm Xoá để clear');
            }
        });

        // === Avatar mode — TỰ LẤY từ TikTok, không cần config URL/file ===
        $('#caro-avatar-enabled')?.addEventListener('change', (e) => {
            updateCfg({ avatarMode: { enabled: e.target.checked } });
            if (e.target.checked) maybeFetchCreatorAvatar(true);
        });
        // Listen username field changes → re-fetch host avatar
        const tikUsernameInput = document.getElementById('username');
        if (tikUsernameInput) {
            tikUsernameInput.addEventListener('change', () => maybeFetchCreatorAvatar());
            tikUsernameInput.addEventListener('blur', () => maybeFetchCreatorAvatar());
        }

        // Practice mode toggle — bật là reset bàn để tap được liền
        $('#caro-practice-mode').addEventListener('change', (e) => {
            updateCfg({ practiceMode: e.target.checked });
            if (e.target.checked) {
                game.practiceReset();
                pushState();
                logSystem('🧪 Bật CHƠI THỬ — tap bàn để đặt quân luân phiên');
            } else {
                game.newGame();
                pushState();
                logSystem('🧪 Tắt CHƠI THỬ — về setup');
            }
        });
        // Rolling mode (tích điểm — N quân/bên)
        $('#caro-rolling-enabled').addEventListener('change', (e) => {
            updateCfg({ rolling: { enabled: e.target.checked } });
            logSystem(e.target.checked
                ? `♻️ Bật TÍCH ĐIỂM — mỗi bên ${cfg.rolling.tokensPerSide} quân, cũ tự mất`
                : '♻️ Tắt TÍCH ĐIỂM');
            // Reset hiệp hiện tại để áp luật mới
            if (game.getState().phase === 'playing') {
                game.resetCurrentRound();
                pushState();
            }
        });
        const rollTok = $('#caro-rolling-tokens'), rollTokV = $('#caro-rolling-tokens-v');
        rollTok.addEventListener('input', () => {
            rollTokV.textContent = rollTok.value;
            updateCfg({ rolling: { tokensPerSide: +rollTok.value } });
        });
        // Custom gift picker — registration
        giftPickers.reg = createGiftPicker($('#caro-reg-gift'), (id) => {
            updateCfg({ registration: { giftId: id } });
        });

        // === Hint "sắp thua không" config ===
        $('#caro-hint-enabled')?.addEventListener('change', (e) => {
            updateCfg({ hint: { enabled: e.target.checked } });
        });
        const hintCdEl = $('#caro-hint-cooldown'), hintCdV = $('#caro-hint-cooldown-v');
        hintCdEl?.addEventListener('input', () => {
            hintCdV.textContent = hintCdEl.value + 's';
            updateCfg({ hint: { cooldownSec: +hintCdEl.value } });
        });
        const hintShowEl = $('#caro-hint-show'), hintShowV = $('#caro-hint-show-v');
        hintShowEl?.addEventListener('input', () => {
            hintShowV.textContent = hintShowEl.value + 's';
            updateCfg({ hint: { showSeconds: +hintShowEl.value } });
        });
        // Gift picker for hint trigger
        if ($('#caro-hint-gift')) {
            giftPickers.hint = createGiftPicker($('#caro-hint-gift'), (id) => {
                updateCfg({ hint: { giftId: id } });
            });
        }
        // Test hint button — chạy threat check ngay với fake user
        $('#caro-btn-test-hint')?.addEventListener('click', () => {
            if (game.getState().phase !== 'playing') {
                flashWarn('Phải đang trong pha chơi (Đối đầu)');
                return;
            }
            const res = game.requestThreatHint({ uniqueId: 'test_' + Date.now(), nickname: 'TEST' });
            if (res.ok) {
                flashOk(`Test: ${res.yes ? 'CÓ ' + res.pattern : 'KHÔNG'}`);
            } else if (res.reason === 'disabled') {
                flashWarn('Bật "💡 Gợi ý sắp thua không" trước');
            } else if (res.reason === 'cooldown') {
                flashWarn(`Cooldown — đợi ${res.remain}s`);
            }
        });
    }

    function wireSeg(selector, cb) {
        const seg = $(selector);
        if (!seg) return;
        seg.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-v]');
            if (!btn) return;
            $$('button', seg).forEach(b => b.classList.toggle('active', b === btn));
            cb(btn.dataset.v);
        });
    }
    function selectSegValue(selector, value) {
        const seg = $(selector);
        if (!seg) return;
        $$('button', seg).forEach(b => b.classList.toggle('active', String(b.dataset.v) === String(value)));
    }
    // Disable nút winLength > min(cols, rows) để user không thể chọn invalid
    function updateWinLenButtons() {
        if (!cfg) return;
        const maxWin = Math.min(cfg.board.cols, cfg.board.rows);
        $$('#caro-winlen-seg button[data-v]').forEach(b => {
            const v = +b.dataset.v;
            if (v > maxWin) {
                b.disabled = true;
                b.style.opacity = '0.3';
                b.title = `Bàn ${cfg.board.cols}×${cfg.board.rows} không đủ ${v} ô liên tiếp`;
            } else {
                b.disabled = false;
                b.style.opacity = '';
                b.title = '';
            }
        });
    }

    function applyConfigToUI() {
        if (!cfg) return;
        $('#caro-cols').value = cfg.board.cols;
        $('#caro-cols-v').textContent = cfg.board.cols;
        $('#caro-rows').value = cfg.board.rows;
        $('#caro-rows-v').textContent = cfg.board.rows;
        $('#caro-scale').value = cfg.display.scale;
        $('#caro-scale-v').textContent = cfg.display.scale + '%';
        selectSegValue('#caro-winlen-seg', cfg.board.winLength);
        updateWinLenButtons();
        selectSegValue('#caro-bo-seg', cfg.match.bestOf);
        selectSegValue('#caro-first-seg', cfg.match.idolFirst ? 'idol' : 'user');
        $('#caro-alternate-first').checked = !!cfg.match.alternateFirst;
        $('#caro-show-history').checked = !!cfg.display.showHistory;
        $('#caro-practice-mode').checked = !!cfg.practiceMode;
        // Cell hints + audio
        $('#caro-cell-hints').checked = !!cfg.display.cellHints;
        $('#caro-cell-hint-op').value = cfg.display.cellHintOpacity ?? 35;
        $('#caro-cell-hint-op-v').textContent = (cfg.display.cellHintOpacity ?? 35) + '%';
        $('#caro-audio-enabled').checked = cfg.audio?.enabled !== false;
        $('#caro-audio-volume').value = cfg.audio?.volume ?? 50;
        $('#caro-audio-volume-v').textContent = (cfg.audio?.volume ?? 50) + '%';
        if ($('#caro-crowd-enabled')) $('#caro-crowd-enabled').checked = !!cfg.crowd?.enabled;
        if ($('#caro-tts-enabled')) {
            $('#caro-tts-enabled').checked = !!cfg.tts?.enabled;
            $('#caro-tts-rate').value = cfg.tts?.rate ?? 1.1;
            $('#caro-tts-rate-v').textContent = (cfg.tts?.rate ?? 1.1) + 'x';
            $('#caro-tts-volume').value = cfg.tts?.volume ?? 80;
            $('#caro-tts-volume-v').textContent = (cfg.tts?.volume ?? 80) + '%';
            // Cách đọc tên (segmented)
            const nm = cfg.tts?.nameMode || 'team';
            document.querySelectorAll('#caro-tts-namemode-seg .caro-seg-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.v === nm);
            });
            const filterCB = $('#caro-tts-filter-banned');
            if (filterCB) filterCB.checked = cfg.tts?.filterBannedNames !== false;
            $('#caro-tts-evt-win').checked = cfg.tts?.events?.win !== false;
            $('#caro-tts-evt-round').checked = cfg.tts?.events?.roundStart !== false;
            $('#caro-tts-evt-threat').checked = cfg.tts?.events?.threat !== false;
            $('#caro-tts-evt-move').checked = !!cfg.tts?.events?.move;
        }
        renderSfxClips();   // Render danh sách clip user đã upload
        // Match-end music labels + tense music
        ['win', 'lose', 'draw'].forEach(kind => {
            const key = kind === 'win' ? 'winMusic' : kind === 'lose' ? 'loseMusic' : 'drawMusic';
            const url = cfg?.audio?.[key] || '';
            const el = document.getElementById(`caro-music-${kind}-current`);
            if (el) el.textContent = url
                ? `🎵 ${decodeURIComponent(url.split('/').pop().split('\\').pop())}`
                : `— Mặc định (${kind === 'win' ? 'Web Audio fanfare' : kind === 'lose' ? 'Web Audio sad' : 'Web Audio chord'})`;
        });
        if ($('#caro-tense-enabled')) {
            $('#caro-tense-enabled').checked = !!cfg.tenseMusic?.enabled;
            const url = cfg?.tenseMusic?.url || '';
            const tenseEl = $('#caro-tense-current');
            if (tenseEl) tenseEl.textContent = url
                ? `🎵 ${decodeURIComponent(url.split('/').pop().split('\\').pop())}`
                : '— Chưa chọn file';
        }
        // Avatar mode config
        if ($('#caro-avatar-enabled')) {
            $('#caro-avatar-enabled').checked = !!cfg.avatarMode?.enabled;
        }
        // Hint config
        if ($('#caro-hint-enabled')) {
            $('#caro-hint-enabled').checked = !!cfg.hint?.enabled;
            $('#caro-hint-cooldown').value = cfg.hint?.cooldownSec ?? 10;
            $('#caro-hint-cooldown-v').textContent = (cfg.hint?.cooldownSec ?? 10) + 's';
            $('#caro-hint-show').value = cfg.hint?.showSeconds ?? 3;
            $('#caro-hint-show-v').textContent = (cfg.hint?.showSeconds ?? 3) + 's';
        }
        // Daily rule config
        if ($('#caro-dailyrule-enabled')) {
            $('#caro-dailyrule-enabled').checked = !!cfg.dailyRule?.enabled;
            $('#caro-dailyrule-text').value = cfg.dailyRule?.text || '';
        }
        // Fog of war config
        if ($('#caro-fog-enabled')) {
            $('#caro-fog-enabled').checked = !!cfg.fogOfWar?.enabled;
            $('#caro-fog-count').value = cfg.fogOfWar?.visibleCount ?? 5;
            $('#caro-fog-count-v').textContent = cfg.fogOfWar?.visibleCount ?? 5;
            selectSegValue('#caro-fog-mode-seg', cfg.fogOfWar?.mode || 'always');
            const giftRow = $('#caro-fog-gift-row');
            if (giftRow) giftRow.style.display = cfg.fogOfWar?.mode === 'gift' ? '' : 'none';
        }
        // Walls config
        if ($('#caro-walls-enabled')) {
            $('#caro-walls-enabled').checked = !!cfg.walls?.enabled;
            $('#caro-walls-count').value = cfg.walls?.count ?? 3;
            $('#caro-walls-count-v').textContent = cfg.walls?.count ?? 3;
        }
        // User-undo config
        if ($('#caro-uu-enabled')) {
            $('#caro-uu-enabled').checked = !!cfg.userUndo?.enabled;
            $('#caro-uu-window').value = cfg.userUndo?.windowSec ?? 3;
            $('#caro-uu-window-v').textContent = (cfg.userUndo?.windowSec ?? 3) + 's';
        }
        // Music
        if ($('#caro-music-enabled')) {
            $('#caro-music-enabled').checked = !!cfg.music?.enabled;
            const trackEl = $('#caro-music-track');
            if (trackEl) trackEl.value = cfg.music?.track || 'calm';
            $('#caro-music-volume').value = cfg.music?.volume ?? 30;
            $('#caro-music-volume-v').textContent = (cfg.music?.volume ?? 30) + '%';
            $('#caro-music-autoplay').checked = cfg.music?.autoPlayOnRound !== false;
            $('#caro-music-custom-url').value = cfg.music?.customUrl || '';
            $('#caro-music-custom-row').style.display = (cfg.music?.track === 'custom') ? '' : 'none';
        }
        // Rolling mode
        if ($('#caro-rolling-enabled')) {
            $('#caro-rolling-enabled').checked = !!cfg.rolling?.enabled;
            $('#caro-rolling-tokens').value = cfg.rolling?.tokensPerSide ?? 3;
            $('#caro-rolling-tokens-v').textContent = cfg.rolling?.tokensPerSide ?? 3;
        }

        // Undo tab
        selectSegValue('#caro-undo-mode-seg', cfg.undo.mode || 'idol');
        $('#caro-undo-window').value = cfg.undo.window;
        $('#caro-undo-window-v').textContent = cfg.undo.window + 's';
        $('#caro-undo-max').value = cfg.undo.maxPerRound;
        $('#caro-undo-max-v').textContent = cfg.undo.maxPerRound;
        $('#caro-undo-cooldown').value = cfg.undo.cooldown;
        $('#caro-undo-cooldown-v').textContent = cfg.undo.cooldown + 's';

        // BO label
        $('#caro-bo-label').textContent = cfg.match.bestOf;
        // Accordion hints — summary text bên phải cho biết nhanh cấu hình
        updateAccordionHints();
    }
    function updateAccordionHints() {
        if (!cfg) return;
        const $h = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        $h('acc-hint-board', `${cfg.board.cols}×${cfg.board.rows} · Win ${cfg.board.winLength}`);
        $h('acc-hint-match', `BO${cfg.match.bestOf} · ${cfg.match.idolFirst ? '🩵 CREATOR' : '🩷 User'} đi`);
        // Reg: tên quà nếu chọn
        const giftId = cfg.registration?.giftId;
        const gift = (window.__giftSheet || []).find(g => String(g.id) === String(giftId));
        $h('acc-hint-reg', gift ? gift.name : 'Chưa chọn quà');
        // Mode
        const modes = [];
        if (cfg.practiceMode) modes.push('🧪 Thử');
        if (cfg.rolling?.enabled) modes.push(`♻️ Tích ${cfg.rolling.tokensPerSide}`);
        $h('acc-hint-mode', modes.length ? modes.join(' · ') : '—');
        // Display
        const dispBits = [`Scale ${cfg.display.scale}%`];
        if (cfg.display.cellHints) dispBits.push(`Hint ${cfg.display.cellHintOpacity}%`);
        $h('acc-hint-display', dispBits.join(' · '));
        // Audio
        $h('acc-hint-audio', cfg.audio?.enabled ? `Bật · ${cfg.audio?.volume || 0}%` : 'Tắt');
        // Avatar mode
        $h('acc-hint-avatar', cfg.avatarMode?.enabled
            ? (cfg.avatarMode?.creatorAvatar ? 'Bật · có ảnh CREATOR' : 'Bật · CREATOR dùng quân tròn')
            : 'Tắt');
        // Walls
        const wallsGift = (window.__giftSheet || []).find(g => String(g.id) === String(cfg.walls?.giftId));
        $h('acc-hint-walls', cfg.walls?.enabled
            ? `${wallsGift?.name || '⚠️ chưa chọn quà'} · ${cfg.walls?.count || 3} tường`
            : 'Tắt');
        // Fog of war
        $h('acc-hint-fog', cfg.fogOfWar?.enabled
            ? `${cfg.fogOfWar?.mode === 'gift' ? '🎁 Qua quà' : '🔄 Luôn'} · hiện ${cfg.fogOfWar?.visibleCount || 5}`
            : 'Tắt');
        // Daily rule
        $h('acc-hint-dailyrule', cfg.dailyRule?.enabled
            ? (cfg.dailyRule?.text ? cfg.dailyRule.text.slice(0, 25) + (cfg.dailyRule.text.length > 25 ? '…' : '') : 'Chưa nhập')
            : 'Tắt');
        // Threat hint
        const hintGift = (window.__giftSheet || []).find(g => String(g.id) === String(cfg.hint?.giftId));
        $h('acc-hint-threathint', cfg.hint?.enabled
            ? `${hintGift?.name || '⚠️ chưa chọn quà'} · cd ${cfg.hint?.cooldownSec || 10}s`
            : 'Tắt');
        // Music
        const musicTrack = MUSIC_TRACKS.find(t => t.id === cfg.music?.track);
        const musicLabel = musicTrack?.label || cfg.music?.track || '—';
        $h('acc-hint-music', cfg.music?.enabled
            ? `${musicLabel.replace(/^[^\w]+/, '').slice(0, 20)} · ${cfg.music?.volume || 0}%`
            : 'Tắt');
    }

    // ---------- Match tab ----------
    function wireMatchTab() {
        $('#caro-btn-open-reg').addEventListener('click', () => {
            if (!cfg.registration.giftId) {
                flashWarn('Vui lòng chọn quà ghi danh ở tab Cấu hình');
                return;
            }
            game.openRegistration();
            logSystem('🏁 Đã mở vòng ghi danh');
            pushState();
            // updateUI tự được gọi qua game.on('change') trong openRegistration()
        });
        $('#caro-btn-close-reg').addEventListener('click', () => {
            game.closeRegistration();
            logSystem('⏹ Đóng vòng ghi danh');
            pushState();
        });
        $('#caro-btn-pick-top').addEventListener('click', () => {
            const st = game.getState();
            if (!st.registration.entries.length) { flashWarn('Chưa có ai ghi danh'); return; }
            const top = st.registration.entries[0];
            game.pickOpponent(top.uniqueId);
            opponentSource = 'reg';
            logSystem(`🎯 Chọn đối thủ: ${top.nickname} (${top.totalDiamond}💎)`);
            pushState();
            updateUI();
        });
        $('#caro-btn-change-opponent').addEventListener('click', () => {
            const st = game.getState();
            if (!st.registration.entries.length) return;
            // Hiện modal chọn — đơn giản: prompt index
            showOpponentPickerModal(st.registration.entries, (uid) => {
                game.pickOpponent(uid);
                opponentSource = 'reg';
                pushState();
                updateUI();
            });
        });
        $('#caro-btn-replay').addEventListener('click', () => {
            game.resetMatch(true);
            $('#caro-end-actions').style.display = 'none';
            logSystem('🔁 Tái đấu với user cũ');
            pushState();
        });
        $('#caro-btn-newreg').addEventListener('click', () => {
            game.newGame();
            game.openRegistration();
            opponentSource = '';
            $('#caro-end-actions').style.display = 'none';
            logSystem('📋 Mở vòng ghi danh mới');
            pushState();
        });
        $('#caro-btn-close-game').addEventListener('click', () => {
            game.newGame();
            opponentSource = '';
            $('#caro-end-actions').style.display = 'none';
            logSystem('❌ Đóng game');
            pushState();
        });

        // === HUỶ ĐỐI THỦ — nút (X) ở card "Đang đấu với" ===
        // Bỏ opponent, về setup → Creator chọn người khác (free-ID hoặc ghi danh).
        $('#caro-btn-clear-opponent')?.addEventListener('click', () => {
            const st = game.getState();
            if (!st.opponent) return;
            const opName = st.opponent.nickname || st.opponent.uniqueId;
            if (st.phase === 'playing') {
                const score = `${st.match.score.idol}–${st.match.score.user}`;
                if (!window.confirm(`Huỷ "${opName}" giữa trận?\nTỉ số ${score} sẽ mất.`)) return;
            }
            game.newGame();
            opponentSource = '';
            $('#caro-end-actions').style.display = 'none';
            logSystem(`✕ Huỷ đối thủ "${opName}"`);
            flashOk('Đã huỷ — chọn đối thủ mới');
            pushState();
            updateUI();   // button states derived từ phase=setup
        });
        // === FREE-ID — Idol nhập @username để đấu trực tiếp, bỏ qua ghi danh ===
        const freeIdGo = () => {
            const inp = $('#caro-freeid-input');
            const raw = (inp?.value || '').trim();
            if (!raw) { flashWarn('Nhập @username hoặc tên TikTok của khán giả'); inp?.focus(); return; }
            const ok = game.pickOpponentManual(raw, raw);
            if (!ok) { flashWarn('ID không hợp lệ'); return; }
            opponentSource = 'freeid';
            // === AUTO-FETCH AVATAR + NICKNAME TikTok theo username (qua tikwm API) ===
            const cleanUid = raw.replace(/^@+/, '').toLowerCase();
            fetch(`/api/tiktok-user-avatar?username=${encodeURIComponent(cleanUid)}`)
                .then(r => r.json())
                .then(data => {
                    if (data?.ok && data.avatarUrl) {
                        game._setOpponentAvatar(cleanUid, data.avatarUrl);
                        // Update nickname thật từ TikTok nếu khác input
                        if (data.nickname && data.nickname !== cleanUid) {
                            const st = game.getState();
                            if (st.opponent && (st.opponent.uniqueId || '').toLowerCase() === cleanUid) {
                                st.opponent.nickname = data.nickname;
                                game.loadState(st);   // re-render với nickname mới
                            }
                        }
                        logSystem(`🖼 Lấy được avatar + nickname TikTok: ${data.nickname || cleanUid}`);
                        flashOk(`Avatar TikTok: ${data.nickname || cleanUid}`);
                    } else {
                        console.warn('[caro] tiktok avatar fetch fail:', data?.error);
                        logSystem(`⚠️ Không lấy được avatar @${cleanUid} (${data?.error || 'unknown'})`);
                    }
                })
                .catch(e => console.warn('[caro] tiktok avatar fetch error:', e.message));
            logSystem(`🎯 Đấu trực tiếp với "${raw}" (bỏ qua ghi danh)`);
            flashOk(`Đã chọn đối thủ: ${raw}`);
            if (inp) inp.value = '';
            pushState();
            updateUI();   // button states derived từ phase=playing + opponent
        };
        $('#caro-btn-freeid-go')?.addEventListener('click', freeIdGo);
        $('#caro-freeid-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); freeIdGo(); }
        });

        // === TEST QUÀ GIẢ — debug ghi danh khi không có gifter thật ===
        // Bắn 1 gift event giả vào chính handler socket.on('gift') để verify flow.
        // Quà giả dùng đúng giftId đang chọn trong cfg → phải match isRegGift=true.
        $('#caro-btn-test-gift')?.addEventListener('click', () => {
            const giftId = cfg?.registration?.giftId;
            if (!giftId) { flashWarn('Chưa chọn quà ghi danh — chọn trong tab Đối đầu'); return; }
            const sheet = window.__giftSheet || [];
            const gift = sheet.find(x => String(x.id) === String(giftId));
            const giftName = gift?.name || 'Test Gift';
            const fakeUid = 'test_' + Math.floor(Math.random() * 10000);
            const fakeRepeat = 1 + Math.floor(Math.random() * 20);
            const fakeGift = {
                uniqueId: fakeUid,
                nickname: `Test ${fakeUid.slice(5)}`,
                profilePicture: '',
                giftId: String(giftId),
                giftName,
                coinValue: gift?.diamond ?? 1,
                repeatCount: fakeRepeat,
                source: 'test'
            };
            handleGiftEvent(fakeGift);
            flashOk(`Test: bắn ${giftName} × ${fakeRepeat} từ ${fakeGift.nickname}`);
        });

        // Reset hiệp hiện tại — KHÔNG đổi tỉ số, không sang round mới.
        // Wire cả nút trong tab Match LẪN nút header (vị trí dễ thấy hơn).
        const resetRoundHandler = () => {
            const st = game.getState();
            if (st.phase === 'setup') { flashWarn('Chưa bắt đầu hiệp nào'); return; }
            const moveCount = st.round.moves.length;
            if (moveCount > 0 && !window.confirm(`Xoá ${moveCount} nước đi của hiệp ${st.round.idx} và bắt đầu lại?\n\nTỉ số ${st.match.score.idol}–${st.match.score.user} sẽ GIỮ NGUYÊN.`)) return;
            game.resetCurrentRound();
            logSystem(`🔁 Reset hiệp ${st.round.idx}`);
            pushState();
        };
        $('#caro-btn-reset-round')?.addEventListener('click', resetRoundHandler);
        $('#caro-btn-reset-round-header')?.addEventListener('click', resetRoundHandler);

        // === PHÂN TÍCH TRẬN — show missed-blocks report ===
        $('#caro-btn-analyze')?.addEventListener('click', () => {
            const r = game.analyzeMatch();
            if (r.totalMoves === 0) { flashWarn('Chưa có nước nào để phân tích'); return; }
            const lines = [];
            lines.push(`📊 Tổng số nước: ${r.totalMoves}`);
            lines.push(`🩵 CREATOR bỏ lỡ block: ${r.missedByCreator}`);
            lines.push(`🩷 USER bỏ lỡ block: ${r.missedByUser}`);
            if (r.criticalMoves.length > 0) {
                lines.push('');
                lines.push('Nước critical:');
                r.criticalMoves.slice(0, 10).forEach(cm => {
                    const who = cm.side === 'idol' ? 'CREATOR' : 'User';
                    lines.push(`  Nước ${cm.moveIdx}: ${who} không chặn ${cm.threatPattern} của ${cm.threatedBy === 'idol' ? 'CREATOR' : 'User'}`);
                });
            }
            alert(lines.join('\n'));
        });

        // === ĐẦU HÀNG — Creator concede match ===
        $('#caro-btn-surrender')?.addEventListener('click', () => {
            const st = game.getState();
            if (st.phase !== 'playing') { flashWarn('Chưa trong trận'); return; }
            const opName = st.opponent?.nickname || 'User';
            if (!window.confirm(`Đầu hàng hiệp này?\n${opName} sẽ thắng + nhận badge Honor Victory.\nTỉ số sẽ tăng cho user.`)) return;
            const res = game.surrender();
            if (!res.ok) {
                if (res.reason === 'cooldown') flashWarn(`Cooldown — đợi ${res.remain}s nữa`);
                else flashWarn(`Đầu hàng fail: ${res.reason}`);
                return;
            }
            logSystem(`🏳️ CREATOR đầu hàng — ${opName} thắng (Honor Victory)`);
            flashOk(`${opName} won by surrender`);
            pushState();
        });
    }

    // ============ DRAW MODAL — bàn đầy không ai thắng ============
    function showDrawModal(isPractice) {
        const existing = $('#caro-draw-modal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.id = 'caro-draw-modal';
        div.className = 'caro-modal-backdrop';
        // Practice: chỉ có Replay. Match: 3 lựa chọn.
        const matchButtons = isPractice ? '' : `
            <button class="ghost block" data-act="half">⏭️ Tính hoà 0.5–0.5 · Sang hiệp sau</button>
            <button class="ghost block" data-act="end">✋ Kết thúc match luôn</button>`;
        div.innerHTML = `
            <div class="caro-modal caro-draw-modal">
                <div class="caro-modal-head"><span>🤝 BÀN ĐẦY — HOÀ!</span></div>
                <div class="caro-modal-body" style="text-align:center; padding: 20px 24px;">
                    <div style="font-size:64px; margin: 8px 0 16px;">🤝</div>
                    <div style="font-size:14px; color: rgba(255,255,255,0.7); margin-bottom: 16px;">
                        Không ai đạt được ${cfg.board.winLength} quân liên tiếp.<br/>
                        Bạn muốn xử lý hiệp này thế nào?
                    </div>
                    <div class="caro-actions">
                        <button class="primary block" data-act="replay">🔁 Đánh lại hiệp này (khuyến nghị)</button>
                        ${matchButtons}
                    </div>
                </div>
            </div>`;
        document.body.appendChild(div);
        div.addEventListener('click', (ev) => {
            const btn = ev.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'replay') { game.drawReplay(); logSystem('🔁 Đánh lại hiệp ' + game.getState().round.idx); }
            else if (act === 'half') { game.drawHalfPoint(); logSystem('⏭️ Tính hoà 0.5–0.5'); }
            else if (act === 'end') { game.drawEndMatch(); logSystem('✋ Kết thúc match theo tỉ số hiện tại'); }
            pushState();
            div.remove();
        });
    }

    function showOpponentPickerModal(entries, onPick) {
        // Modal đơn giản inline
        const existing = $('#caro-picker-modal');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.id = 'caro-picker-modal';
        div.className = 'caro-modal-backdrop';
        div.innerHTML = `
            <div class="caro-modal">
                <div class="caro-modal-head">
                    <span>📋 Chọn đối thủ</span>
                    <button class="modal-close" id="caro-picker-close">✕</button>
                </div>
                <div class="caro-modal-body" id="caro-picker-list"></div>
            </div>`;
        document.body.appendChild(div);
        const list = $('#caro-picker-list', div);
        entries.forEach((e, i) => {
            const row = document.createElement('div');
            row.className = 'caro-picker-row';
            row.innerHTML = `
                <span class="rank">#${i + 1}</span>
                <img class="avatar" src="${e.profilePic || '/favicon.ico'}" alt="" />
                <span class="name">${escapeHtml(e.nickname)}</span>
                <span class="dia">${e.totalDiamond}💎</span>
                <button class="primary small">Chọn</button>`;
            row.querySelector('button').addEventListener('click', () => {
                onPick(e.uniqueId);
                div.remove();
            });
            list.appendChild(row);
        });
        $('#caro-picker-close', div).addEventListener('click', () => div.remove());
        div.addEventListener('click', (ev) => { if (ev.target === div) div.remove(); });
    }

    // ---------- Undo tab ----------
    function wireUndoTab() {
        wireSeg('#caro-undo-mode-seg', (v) => updateCfg({ undo: { mode: v } }));
        const win = $('#caro-undo-window'), winV = $('#caro-undo-window-v');
        const max = $('#caro-undo-max'), maxV = $('#caro-undo-max-v');
        const cd = $('#caro-undo-cooldown'), cdV = $('#caro-undo-cooldown-v');
        win.addEventListener('input', () => { winV.textContent = win.value + 's'; updateCfg({ undo: { window: +win.value } }); });
        max.addEventListener('input', () => { maxV.textContent = max.value; updateCfg({ undo: { maxPerRound: +max.value } }); });
        cd.addEventListener('input', () => { cdV.textContent = cd.value + 's'; updateCfg({ undo: { cooldown: +cd.value } }); });
        // Custom gift picker — undo
        giftPickers.undo = createGiftPicker($('#caro-undo-gift'), (id) => updateCfg({ undo: { giftId: id } }));

        $('#caro-btn-undo').addEventListener('click', () => {
            if (cfg.undo.mode === 'off') { flashWarn('Hoàn nước đang bị tắt'); return; }
            const res = game.undoLastMove();
            if (!res.ok) flashWarn(translateReason(res.reason, res));
            else {
                logSystem(`🔄 Đã hoàn nước cuối (${res.undone.side === 'idol' ? '🩵' : '🩷'})`);
                pushState();
            }
        });

        // === User-undo bằng quà (chấp User) ===
        $('#caro-uu-enabled')?.addEventListener('change', (e) => {
            updateCfg({ userUndo: { enabled: e.target.checked } });
        });
        const uuWin = $('#caro-uu-window'), uuWinV = $('#caro-uu-window-v');
        uuWin?.addEventListener('input', () => {
            uuWinV.textContent = uuWin.value + 's';
            updateCfg({ userUndo: { windowSec: +uuWin.value } });
        });
        if ($('#caro-uu-gift')) {
            giftPickers.uu = createGiftPicker($('#caro-uu-gift'), (id) => {
                updateCfg({ userUndo: { giftId: id } });
            });
        }
        $('#caro-btn-test-uu')?.addEventListener('click', () => {
            const opponent = game.getState().opponent;
            const res = game.tryUserUndoByGift({ uniqueId: opponent?.uniqueId, nickname: opponent?.nickname || 'TEST' });
            if (res.ok) {
                logSystem(`⚡ Test: hoàn nước User ${res.undone.c + 1}${String.fromCharCode(65 + res.undone.r)}`);
                flashOk('Hoàn nước OK');
                pushState();
            } else {
                flashWarn(`Test fail: ${res.reason}`);
            }
        });
    }

    // ---------- Save / overlay copy ----------
    function wireCopyOverlay() {
        const inp = $('#caro-overlay-url');
        const url = location.origin + '/overlay/caro';
        if (inp) inp.value = url;
        $('#caro-btn-copy').addEventListener('click', async () => {
            const ok = window.hpCopyText ? await window.hpCopyText(url) : false;
            if (ok) flashOk('Đã copy link OBS overlay Caro');
            else flashWarn('Copy thất bại — link: ' + url);
        });
    }

    function wireSave() {
        $('#caro-btn-save').addEventListener('click', () => {
            saveConfig().then(() => flashOk('Đã lưu cài đặt Caro')).catch(e => flashWarn(e.message));
        });
    }

    async function saveConfig() {
        const r = await fetch('/api/games/caro/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        if (!r.ok) throw new Error('Save fail');
    }

    // Debounced auto-save
    function updateCfg(patch) {
        cfg = deepMerge(cfg, patch);
        if (game) game.setConfig(cfg);
        updateAccordionHints();
        clearTimeout(pendingSave);
        pendingSave = setTimeout(() => {
            saveConfig().catch(() => {});
        }, 500);
    }

    function deepMerge(target, src) {
        const out = Object.assign({}, target);
        for (const k of Object.keys(src)) {
            if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
                out[k] = deepMerge(target[k] || {}, src[k]);
            } else {
                out[k] = src[k];
            }
        }
        return out;
    }

    // ---------- Server bridge ----------
    function pushState() {
        if (!game) return;
        const state = game.getState();
        fetch('/api/games/caro/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        }).catch(() => {});
    }

    function bindSocket() {
        if (!socket) return;
        // Comment listener — parse coord khi đến lượt user (hoặc User A trong UvU mode)
        socket.on('chat', (data) => {
            // Game bị TẮT trong Thư viện → bỏ qua mọi comment để game không nhận nước cờ
            if (cfg && cfg.enabled === false) return;
            if (!game) return;
            const st = game.getState();
            // === AUTO-FETCH AVATAR — update profilePic của opponent/opponentA từ chat events ===
            // Free-ID flow: user gõ ID, chưa có avatar; khi user comment → grab profilePic ngay.
            if (data.profilePicture && game._setOpponentAvatar) {
                game._setOpponentAvatar(data.uniqueId, data.profilePicture);
            }
            // === WALL PLACING PHASE — user được chọn comment toạ độ để đặt tường ===
            if (st.walls?.phase === 'placing') {
                const senderUid = (data.uniqueId || '').toLowerCase();
                const designatedUid = (st.walls.placedBy || '').toLowerCase();
                if (senderUid === designatedUid && st.walls.opportunitiesUser > 0) {
                    const text = data.comment || '';
                    const coord = game.parseCoord(text);
                    if (coord) {
                        const res = game.wallPlace(coord.c, coord.r, 'user-comment');
                        if (res.ok) {
                            logSystem(`🧱 ${data.nickname || senderUid} đặt tường tại ${coord.c+1}${String.fromCharCode(65+coord.r)}`);
                            appendComment(data, text, 'accepted');
                            pushState();
                        } else {
                            appendComment(data, text, 'rejected');
                            logSystem(`⚠️ Wall fail: ${res.reason}`);
                        }
                    }
                }
                return;   // KHÔNG chạy logic placeStone khi đang placing walls
            }
            if (st.phase !== 'playing') return;
            if (!st.opponent) return;
            // Chỉ xử lý comment từ ĐÚNG opponent
            if ((data.uniqueId || '').toLowerCase() !== (st.opponent.uniqueId || '').toLowerCase()) return;
            const text = data.comment || '';
            const coord = game.parseCoord(text);
            if (!coord) {
                appendComment(data, text, 'unparsed');
                return;
            }
            // === CẢNH BÁO "CHƯA TỚI LƯỢT" ===
            // Comment là TỌA ĐỘ HỢP LỆ nhưng đang là lượt CREATOR → reject + báo rõ.
            if (st.round.turn !== 'user') {
                appendComment(data, text, 'rejected');
                flashWarn(`${data.nickname || data.uniqueId}: "${text}" — Bạn chưa đến lượt`);
                logSystem(`⚠️ ${data.nickname || data.uniqueId} đánh "${text}" nhưng chưa tới lượt`);
                return;
            }
            const res = game.placeStone(coord.c, coord.r, 'user');
            if (!res.ok) {
                appendComment(data, text, 'rejected');
                flashWarn(`Cmt "${text}" — ${translateReason(res.reason)}`);
                return;
            }
            appendComment(data, text, 'accepted');
            // logMove được trigger qua game.on('placed') ở init
            pushState();
        });

        // Gift listener — registration phase
        socket.on('gift', handleGiftEvent);

        // Gift sheet load → fill selects
        socket.on('giftSheet', (list) => {
            window.__giftSheet = list;
            refreshGiftOptions();
        });
        // Host (CREATOR) profile từ server → lưu cho avatar mode + render
        socket.on('hostInfo', (info) => {
            window.__hostInfo = info;
            // Force re-render canvas để pick avatar mới
            if (game) game.setConfig({});
        });
    }

    // === Auto-fetch Creator avatar TỪ USERNAME đã typed (kể cả chưa connect LIVE) ===
    // Trigger: khi panel mở + avatar mode ON, hoặc khi user đổi username TikTok input.
    let _lastFetchedHostUsername = '';
    function maybeFetchCreatorAvatar(force) {
        if (!cfg?.avatarMode?.enabled && !force) return;
        // Lấy username từ field connect TikTok (app.js dùng #username)
        const inp = document.getElementById('username');
        const uname = String(inp?.value || '').trim().replace(/^@+/, '').toLowerCase();
        if (!uname) return;
        if (uname === _lastFetchedHostUsername && !force) return;
        // Nếu hostInfo từ server đã có (đang LIVE) → KHÔNG đè
        if (window.__hostInfo?.profilePic && window.__hostInfo.uniqueId?.toLowerCase() === uname) return;
        _lastFetchedHostUsername = uname;
        fetch(`/api/tiktok-user-avatar?username=${encodeURIComponent(uname)}`)
            .then(r => r.json())
            .then(data => {
                if (data?.ok && data.avatarUrl) {
                    window.__hostInfo = {
                        uniqueId: uname,
                        nickname: data.nickname || uname,
                        profilePic: data.avatarUrl,
                        userId: '',
                        level: 0,
                        verified: false
                    };
                    if (game) game.setConfig({});   // force re-render
                    logSystem(`🖼 Lấy avatar CREATOR: ${data.nickname || uname}`);
                }
            })
            .catch(() => {});
    }

    // ---------- Gift event handler (gọi từ socket VÀ từ nút Test) ----------
    function handleGiftEvent(g) {
        const st0 = game ? game.getState() : null;
        const giftIdIn = String(g.giftId ?? '').trim();
        const giftIdCfg = String(cfg?.registration?.giftId ?? '').trim();
        let isRegGift = giftIdIn !== '' && giftIdCfg !== '' && giftIdIn === giftIdCfg;
        // === Threat hint gift check (chạy SONG SONG với reg gift — quà có thể vừa reg vừa hint nếu trùng id) ===
        const hintGiftId = String(cfg?.hint?.giftId ?? '').trim();
        const isHintGift = cfg?.hint?.enabled && giftIdIn !== '' && hintGiftId !== '' && giftIdIn === hintGiftId;
        if (isHintGift && game && st0?.phase === 'playing') {
            const res = game.requestThreatHint({ uniqueId: g.uniqueId, nickname: g.nickname });
            if (res.ok) {
                logSystem(`💡 ${g.nickname || g.uniqueId} hỏi gợi ý → ${res.yes ? 'CÓ (' + res.pattern + ')' : 'KHÔNG'}`);
                SoundManager.play(res.yes ? 'hint-yes' : 'hint-no');
                pushState();
            } else if (res.reason === 'cooldown') {
                logSystem(`💤 ${g.nickname || g.uniqueId} hỏi gợi ý — cooldown ${res.remain}s`);
            }
        }
        // === Fog gift — kích hoạt sương mù 1 lượt ===
        const fogGiftId = String(cfg?.fogOfWar?.giftId ?? '').trim();
        const isFogGift = cfg?.fogOfWar?.enabled && cfg?.fogOfWar?.mode === 'gift'
            && giftIdIn !== '' && fogGiftId !== '' && giftIdIn === fogGiftId;
        if (isFogGift && game) {
            const res = game.fogActivate({ uniqueId: g.uniqueId, nickname: g.nickname });
            if (res.ok) {
                logSystem(`🌫 ${g.nickname || g.uniqueId} tặng quà → sương mù 1 lượt (hiện ${res.count} quân)`);
                flashOk('Sương mù kích hoạt 1 lượt');
                pushState();
            }
        }
        // === Walls — quà chỉ định tăng cơ hội cho user được chọn comment đặt tường ===
        const wallsGiftId = String(cfg?.walls?.giftId ?? '').trim();
        const isWallsGift = cfg?.walls?.enabled && giftIdIn !== '' && wallsGiftId !== '' && giftIdIn === wallsGiftId;
        if (isWallsGift && game && st0?.walls?.phase === 'placing') {
            const res = game.wallAddGiftOpportunity(g.uniqueId);
            if (res.ok) {
                const stW = game.getState();
                logSystem(`🎁 ${g.nickname || g.uniqueId} tặng quà tường → @${stW.walls.placedBy} có ${stW.walls.opportunitiesUser} cơ hội`);
                flashOk(`+1 cơ hội tường cho @${stW.walls.placedBy}`);
                pushState();
            } else {
                logSystem(`🧱 Wall opportunity fail: ${res.reason}`);
            }
        }
        // === User-undo bằng quà — chỉ opponent đang chơi mới hoàn được nước của mình ===
        const uuGiftId = String(cfg?.userUndo?.giftId ?? '').trim();
        const isUuGift = cfg?.userUndo?.enabled && giftIdIn !== '' && uuGiftId !== '' && giftIdIn === uuGiftId;
        if (isUuGift && game && st0?.phase === 'playing') {
            const res = game.tryUserUndoByGift({ uniqueId: g.uniqueId, nickname: g.nickname });
            if (res.ok) {
                logSystem(`⚡ ${g.nickname || g.uniqueId} HOÀN NƯỚC qua quà: ${res.undone.c + 1}${String.fromCharCode(65 + res.undone.r)}`);
                flashOk(`User hoàn nước cuối`);
                pushState();
            } else if (res.reason !== 'no_window' && res.reason !== 'expired') {
                // Chỉ log lỗi đáng chú ý — no_window/expired là bình thường (window đã đóng)
                logSystem(`⚡ ${g.nickname || g.uniqueId} muốn hoàn nhưng: ${res.reason}`);
            }
        }
        // Fallback: id không khớp NHƯNG tên trùng tên quà đã chọn → vẫn nhận
        if (!isRegGift && giftIdCfg) {
            const cfgGift = (window.__giftSheet || []).find(x => String(x.id) === giftIdCfg);
            const inName = String(g.giftName || '').trim().toLowerCase();
            const cfgName = String(cfgGift?.name || '').trim().toLowerCase();
            if (cfgName && inName && cfgName === inName) isRegGift = true;
        }
        // === DIAGNOSTIC LOG — luôn ghi mọi gift event tới panel ===
        console.log('[caro] gift event', {
            giftId: giftIdIn, expected: giftIdCfg, match: isRegGift,
            phase: st0?.phase, regOpen: st0?.registration?.open,
            nickname: g.nickname, giftName: g.giftName,
            coinValue: g.coinValue, repeat: g.repeatCount, source: g.source
        });
        logSystem(`🎁 ${g.nickname || g.uniqueId}: ${g.giftName || g.giftId} (id=${giftIdIn}, cần=${giftIdCfg || 'chưa chọn'}) ${isRegGift ? '✓' : '✗'}`);

        if (cfg && cfg.enabled === false) { logSystem('⛔ Game đang tắt — bỏ qua'); return; }
        if (!game) return;
        let st = st0;
        // AUTO-OPEN ghi danh khi phase=setup và có quà đúng
        if (isRegGift && st.phase === 'setup') {
            game.openRegistration();
            logSystem('🏁 Tự mở ghi danh (có quà ghi danh đầu tiên)');
            st = game.getState();
            // Button states tự sync qua game.on('change') → updateUI()
        }
        if (st.phase !== 'registration' && st.phase !== 'picking') {
            logSystem(`⏸ Bỏ qua (phase=${st.phase}, chưa ở pha ghi danh/picking)`);
            return;
        }
        if (!isRegGift && st.phase === 'registration') return;
        const entriesBefore = game.getState().registration.entries.length;
        game.addGift({
            uniqueId: g.uniqueId,
            nickname: g.nickname,
            profilePicture: g.profilePicture,
            coinValue: g.coinValue,
            repeatCount: g.repeatCount,
            giftId: g.giftId
        }, isRegGift);
        const stAfter = game.getState();
        const entriesAfter = stAfter.registration.entries.length;
        if (entriesAfter > entriesBefore) {
            logSystem(`📝 ${g.nickname || g.uniqueId} GHI DANH (${g.giftName || 'quà'} × ${g.repeatCount || 1})`);
            flashOk(`Ghi danh: ${g.nickname || g.uniqueId}`);
        } else if (isRegGift) {
            const diamond = (Number(g.coinValue) || 1) * (Number(g.repeatCount) || 1);
            logSystem(`➕ ${g.nickname || g.uniqueId} cộng +${diamond}💎`);
        } else {
            logSystem(`💎 ${g.nickname || g.uniqueId} tip thêm`);
        }
        pushState();
        updateUI();
    }

    function refreshGiftOptions() {
        const list = window.__giftSheet || [];
        if (giftPickers.reg) {
            giftPickers.reg.setList(list);
            giftPickers.reg.setValue(cfg?.registration?.giftId || '');
        }
        if (giftPickers.undo) {
            giftPickers.undo.setList(list);
            giftPickers.undo.setValue(cfg?.undo?.giftId || '');
        }
        if (giftPickers.hint) {
            giftPickers.hint.setList(list);
            giftPickers.hint.setValue(cfg?.hint?.giftId || '');
        }
        if (giftPickers.uu) {
            giftPickers.uu.setList(list);
            giftPickers.uu.setValue(cfg?.userUndo?.giftId || '');
        }
        if (giftPickers.walls) {
            giftPickers.walls.setList(list);
            giftPickers.walls.setValue(cfg?.walls?.giftId || '');
        }
        if (giftPickers.fog) {
            giftPickers.fog.setList(list);
            giftPickers.fog.setValue(cfg?.fogOfWar?.giftId || '');
        }
    }

    // ---------- UI updaters ----------
    function updateOpponentCard(st) {
        const card = $('#caro-opponent-card');
        if (!card) return;
        const op = st.opponent;
        if (!op) {
            card.style.display = 'none';
            return;
        }
        card.style.display = '';
        const nameEl = $('#caro-opponent-name');
        const uidEl = $('#caro-opponent-uid');
        const avEl = $('#caro-opponent-avatar');
        const diaEl = $('#caro-opponent-dia');
        const srcEl = $('#caro-opponent-source');
        if (nameEl) nameEl.textContent = op.nickname || op.uniqueId || '—';
        if (uidEl) uidEl.textContent = op.uniqueId ? '@' + op.uniqueId : '';
        if (avEl) avEl.src = op.profilePic || '/favicon.ico';
        if (diaEl) {
            const d = Number(op.totalDiamond) || 0;
            diaEl.textContent = d > 0 ? `${d}💎` : '';
        }
        if (srcEl) srcEl.textContent = opponentSource === 'freeid' ? '🆔 Nhập tay' : (opponentSource === 'reg' ? '🎁 Qua ghi danh' : '');
    }

    function updateUI() {
        if (!game) return;
        const st = game.getState();
        // Phase pill
        const phaseNames = {
            setup: 'Setup', registration: 'Ghi danh',
            picking: 'Đang chọn đối thủ', playing: `Đối đầu — Hiệp ${st.round.idx}`,
            roundEnd: `Kết thúc hiệp ${st.round.idx}`, matchEnd: 'Match kết thúc'
        };
        $('#caro-phase-pill').innerHTML = 'Đang ở pha: <b>' + (phaseNames[st.phase] || st.phase) + '</b>';

        // Persistent opponent card
        updateOpponentCard(st);

        // Turn label
        const turnLab = st.phase === 'playing'
            ? (st.round.turn === 'idol' ? '🩵 CREATOR' : `🩷 ${st.opponent?.nickname || 'USER'}`)
            : '—';
        $('#caro-turn-label').textContent = turnLab;
        $('#caro-round-label').textContent = st.round.idx;
        $('#caro-score-label').textContent = `${st.match.score.idol} - ${st.match.score.user}`;

        // Undo status
        $('#caro-undo-used').textContent = st.round.undosUsed;
        $('#caro-undo-cap').textContent = cfg.undo.maxPerRound;

        // Leaderboard
        renderLeaderboard(st.registration.entries, st.opponent?.uniqueId);

        // Match end?
        if (st.phase === 'matchEnd') {
            $('#caro-end-actions').style.display = 'block';
        }

        // === ROOT-CAUSE FIX: button states DERIVED từ game state ===
        // Trước đây tự bật/tắt trong click handlers → stuck khi user reload panel
        // hoặc đổi flow giữa chừng (vd pick gift sau khi đã Mở ghi danh).
        // Giờ source-of-truth là game state, updateUI() sync mỗi khi state đổi.
        const isSetup = st.phase === 'setup';
        const isReg = st.phase === 'registration';
        const isPicking = st.phase === 'picking';
        const isPlaying = st.phase === 'playing';
        const isRoundEnd = st.phase === 'roundEnd';
        const isRegOpen = !!st.registration.open;
        const hasEntries = st.registration.entries.length > 0;
        const hasOpponent = !!st.opponent;
        // Mở ghi danh: enabled trong setup HOẶC reg-đã-đóng (cho phép mở lại vòng mới).
        // Disabled khi đang playing/picking/matchEnd hoặc reg đang mở.
        $('#caro-btn-open-reg').disabled = !(isSetup || (isReg && !isRegOpen)) || hasOpponent;
        // Đóng ghi danh: chỉ enabled khi reg đang mở
        $('#caro-btn-close-reg').disabled = !(isReg && isRegOpen);
        // Chọn Top 1: cần entries + đang ở reg/picking + chưa có opponent
        $('#caro-btn-pick-top').disabled = !hasEntries || !(isReg || isPicking) || hasOpponent;
        // Đổi đối thủ: cần entries để chọn người khác
        $('#caro-btn-change-opponent').disabled = !hasEntries;

    }

    function renderLeaderboard(entries, currentOpponentUid) {
        const host = $('#caro-leaderboard');
        if (!host) return;
        if (!entries.length) {
            host.innerHTML = '<div class="caro-lb-empty">Chưa có ai ghi danh</div>';
            return;
        }
        host.innerHTML = '';
        entries.slice(0, 20).forEach((e, idx) => {
            const row = document.createElement('div');
            row.className = 'caro-lb-row' + (e.uniqueId === currentOpponentUid ? ' active' : '');
            row.innerHTML = `
                <span class="rank">#${idx + 1}</span>
                <img class="avatar" src="${e.profilePic || '/favicon.ico'}" alt="" onerror="this.src='/favicon.ico'" />
                <span class="name">${escapeHtml(e.nickname)}</span>
                <span class="dia">${e.totalDiamond}💎</span>`;
            host.appendChild(row);
        });
    }

    // ---------- Logs ----------
    function appendComment(data, text, status) {
        const host = $('#caro-comments');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'caro-comment ' + status;
        const tag = { accepted: '✓', rejected: '✕', unparsed: '?' }[status] || '·';
        div.innerHTML = `<span class="tag">${tag}</span>
            <img class="avatar" src="${data.profilePicture || '/favicon.ico'}" onerror="this.src='/favicon.ico'" />
            <span class="name">${escapeHtml(data.nickname || data.uniqueId)}</span>
            <span class="text">${escapeHtml(text)}</span>`;
        // Prepend — cmt MỚI nhất nằm TRÊN cùng
        host.insertBefore(div, host.firstChild);
        // Cap số cmt giữ trong DOM
        while (host.children.length > 80) host.removeChild(host.lastChild);
    }
    function logMove(side, cell) {
        const host = $('#caro-log');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'caro-log-line ' + side;
        const st = game?.getState();
        const userName = st?.opponent?.nickname || 'USER';
        const tag = side === 'idol' ? '🩵 CREATOR' : `🩷 ${userName}`;
        const c = cell.c + 1, r = String.fromCharCode(65 + cell.r);
        div.textContent = `${game.getState().round.moves.length}. ${tag} → ${c}${r}`;
        host.appendChild(div);
        host.scrollTop = host.scrollHeight;
        while (host.children.length > 50) host.removeChild(host.firstChild);
    }
    function logSystem(text) {
        const host = $('#caro-log');
        if (!host) return;
        const div = document.createElement('div');
        div.className = 'caro-log-line system';
        div.textContent = text;
        host.appendChild(div);
        host.scrollTop = host.scrollHeight;
    }

    function translateReason(reason, info) {
        const map = {
            not_playing: 'Không trong pha chơi',
            not_turn: 'Chưa tới lượt',
            not_user_turn: 'Chưa tới lượt user',
            not_opponent: 'Không phải đối thủ được chọn',
            round_over: 'Hiệp đã kết thúc',
            occupied: 'Ô đã có quân',
            oob: 'Ngoài bàn cờ',
            empty: 'Không có nước để hoàn',
            limit_reached: 'Đã hết lượt hoàn',
            window_expired: 'Quá thời gian hoàn',
            cooldown: `Cooldown — chờ ${info?.remain || ''}s`,
            parse_fail: 'Không đọc được tọa độ'
        };
        return map[reason] || reason;
    }

    function flashWarn(text) {
        const el = document.createElement('div');
        el.className = 'caro-toast warn';
        el.textContent = '⚠️ ' + text;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
    }
    function flashOk(text) {
        const el = document.createElement('div');
        el.className = 'caro-toast ok';
        el.textContent = '✓ ' + text;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2000);
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
})();
