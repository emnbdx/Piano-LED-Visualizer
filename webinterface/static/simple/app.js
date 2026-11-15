// Simple interface: practice home page, settings, debug and setup wizard.
(function () {
    "use strict";

    const $ = (selector, root) => (root || document).querySelector(selector);
    const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

    function el(tag, props, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (key === "class") node.className = value;
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else if (key in node) node[key] = value;
            else node.setAttribute(key, value);
        }
        for (const child of children) {
            if (child !== null && child !== undefined) node.append(child);
        }
        return node;
    }

    // ---------------------------------------------------------------- server

    async function api(path, options) {
        const response = await fetch(path, options);
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* not every endpoint answers in JSON */ }
        if (!response.ok) {
            throw Object.assign(new Error((data && data.error) || response.statusText), {status: response.status});
        }
        return data === null ? text : data;
    }

    function setSetting(name, value, secondValue) {
        const params = new URLSearchParams({setting_name: name, value: value === undefined ? "" : value});
        if (secondValue !== undefined) params.set("second_value", secondValue);
        return api("/api/change_setting?" + params);
    }

    function postJson(path, body) {
        return api(path, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
        });
    }

    // ------------------------------------------------------------ feedback

    let toastTimer = null;

    function toast(text, bad) {
        const node = $("#toast");
        node.textContent = text;
        node.classList.toggle("bad", !!bad);
        node.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
    }

    function askConfirm(text) {
        const dialog = $("#confirm");
        $("#confirm-text").textContent = text;
        dialog.showModal();
        return new Promise(resolve => {
            const finish = answer => {
                dialog.close();
                $("#confirm-yes").onclick = $("#confirm-no").onclick = dialog.oncancel = null;
                resolve(answer);
            };
            $("#confirm-yes").onclick = () => finish(true);
            $("#confirm-no").onclick = () => finish(false);
            dialog.oncancel = () => finish(false);
        });
    }

    // --------------------------------------------------------------- state

    const state = {
        server: null,        // last answer of /api/simple/state
        socketOpen: false,
        songs: [],
        song: null,          // file name of the selected song
        songReady: false,
        notes: [],           // [note, start, duration, hand] sorted by start
        duration: 0,
        percentTimes: [],    // song time at each percent of the passage sliders
        running: false,
        waiting: false,      // the engine is waiting for the player's notes
        userStopped: false,
        sessionOpen: false,  // a session was started or followed from this page
        position: 0,         // song time currently at the keyboard line
        target: 0,           // song time the engine is heading to
        pressed: new Set(),  // keys held on the real piano
        colors: {1: "#7be495", 2: "#7aa7ff", 0: "#f2b544"},
    };

    const learning = () => (state.server ? state.server.learning : {});

    // Screen colours follow the LED colours, lightened so they read on a dark background
    function screenColor(hex) {
        const value = parseInt(hex.slice(1), 16);
        const mix = channel => Math.round(channel + (255 - channel) * 0.35);
        return `rgb(${mix(value >> 16)}, ${mix((value >> 8) & 255)}, ${mix(value & 255)})`;
    }

    async function refreshState() {
        try {
            state.server = await api("/api/simple/state");
        } catch (e) {
            updateStatus(false);
            return null;
        }
        state.colors[1] = screenColor(state.server.learning.color_right);
        state.colors[2] = screenColor(state.server.learning.color_left);
        syncControls();
        syncRecorder();
        updateStatus(true);
        return state.server;
    }

    const isRealPort = name => !/midi through|rtmidi/i.test(name);

    function updateStatus(reachable) {
        const node = $("#piano-status");
        const ports = state.server ? state.server.ports.filter(isRealPort) : [];
        const ok = reachable && state.socketOpen && ports.length > 0;
        node.classList.toggle("ok", ok);
        $("#piano-status-text").textContent =
            !reachable ? t("offline") : (ports.length ? t("piano_connected") : t("piano_missing"));
    }

    // --------------------------------------------------------------- views

    const VIEW_ALIASES = {network: "settings", ports: "settings", ledsettings: "settings", home: "practice", songs: "practice"};
    let viewTimer = null;

    function showView(name) {
        name = VIEW_ALIASES[name] || name;
        if (!["practice", "settings", "debug"].includes(name)) name = "practice";

        $$(".view").forEach(view => { view.hidden = view.id !== "view-" + name; });
        $$(".tabs button").forEach(tab => tab.setAttribute("aria-selected", tab.dataset.view === name));
        if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);

        clearInterval(viewTimer);
        if (name === "settings") {
            refreshState().then(() => showSettingsSection(recall("plv_settings_section")));
        } else if (name === "debug") {
            loadStats();
            loadLogs();
            viewTimer = setInterval(() => { loadStats(); loadLogs(); }, 3000);
        } else {
            resizeRoll();
        }
    }

    // ------------------------------------------------------------- library

    function renderSongs() {
        const list = $("#song-list");
        const query = $("#song-search").value.trim().toLowerCase();
        const songs = state.songs.filter(song => song.title.toLowerCase().includes(query));
        list.replaceChildren();

        if (!songs.length) {
            list.append(el("li", {class: "empty", textContent: t(state.songs.length ? "no_match" : "no_songs")}));
            return;
        }
        for (const song of songs) {
            list.append(el("li", {class: song.name === state.song ? "selected" : ""},
                el("button", {class: "song", textContent: song.title, onclick: () => selectSong(song.name)}),
                el("button", {
                    class: "song-delete", textContent: "×", title: t("delete_song"),
                    "aria-label": t("delete_song") + " " + song.title,
                    onclick: () => deleteSong(song),
                })));
        }
    }

    async function loadSongs() {
        try {
            state.songs = (await api("/api/simple/songs")).songs;
        } catch (e) {
            state.songs = [];
        }
        renderSongs();
    }

    async function deleteSong(song) {
        if (!await askConfirm(t("delete_song_confirm", {name: song.title}))) return;
        if (song.name === state.song) {
            await stopSession();
            clearSong();
        }
        await setSetting("remove_song", song.name).catch(() => toast(t("error"), true));
        loadSongs();
    }

    async function uploadFiles(files) {
        for (const file of files) {
            const body = new FormData();
            body.append("file", file);
            let ok = false;
            try {
                ok = (await api("/upload", {method: "POST", body})).success;
            } catch (e) { /* reported below */ }
            toast(t(ok ? "upload_done" : "upload_failed", {name: file.name}), !ok);
        }
        loadSongs();
    }

    // ------------------------------------------------------------ recorder

    let recordStart = 0;
    let recordTimer = null;

    function syncRecorder() {
        const recording = !!(state.server && state.server.recording);
        $("#record-start").hidden = recording;
        $("#record-active").hidden = !recording;
        clearInterval(recordTimer);
        if (recording) {
            if (!recordStart) recordStart = Date.now();
            const tick = () => { $("#record-time").textContent = clock((Date.now() - recordStart) / 1000); };
            tick();
            recordTimer = setInterval(tick, 1000);
        } else {
            recordStart = 0;
        }
    }

    async function recorderAction(setting, message) {
        try {
            await setSetting(setting, "0");
            if (message) toast(t(message));
        } catch (e) {
            toast(t("error"), true);
        }
        await refreshState();
        if (setting === "save_recording") loadSongs();
    }

    // ------------------------------------------------------------ practice

    function clock(seconds) {
        seconds = Math.max(0, Math.round(seconds));
        return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    }

    function setSegment(id, value) {
        $$("#" + id + " button").forEach(button =>
            button.setAttribute("aria-checked", String(button.dataset.value === String(value))));
    }

    function syncControls() {
        const status = learning();
        setSegment("mode-seg", status.practice);
        setSegment("hands-seg", status.hands);
        if (document.activeElement !== $("#tempo")) {
            $("#tempo").value = status.tempo;
            $("#tempo-value").textContent = status.tempo + "%";
        }
        $("#leds-toggle").checked = !!status.leds;
        $("#loop-toggle").checked = !!status.loop;
        if (!state.running && status.running && state.songReady) setRunning(true);
        if (state.running && !status.running) setRunning(false);
        updateTimeline();
    }

    function updatePlayButton() {
        const button = $("#play-btn");
        button.textContent = state.song && !state.songReady ? t("loading_song") : t(state.running ? "stop" : "start");
        button.disabled = !state.songReady;
        $("#scorebox").hidden = !state.running || learning().practice === 2;
    }

    function setRunning(running) {
        state.running = running;
        if (running) state.sessionOpen = true;
        if (!running) {
            state.waiting = false;
            $("#wait-chip").hidden = true;
            state.position = state.target = passageStart();
        }
        updatePlayButton();
    }

    const passageStart = () => state.percentTimes[Math.round(learning().start_point || 0)] || 0;
    const passageEnd = () => {
        const end = learning().end_point;
        return state.percentTimes[Math.round(end === undefined ? 100 : end)] || state.duration;
    };

    function clearSong() {
        state.song = null;
        state.songReady = false;
        state.notes = [];
        state.duration = 0;
        state.percentTimes = [];
        $("#song-title").textContent = t("pick_song");
        $("#roll-hint").hidden = false;
        $("#timeline").hidden = true;
        $("#sheet-panel").hidden = true;
        updatePlayButton();
        renderSongs();
    }

    async function selectSong(name, resume) {
        if (name === state.song && state.songReady) {
            $("#library").classList.remove("open");
            return;
        }
        if (!resume) await stopSession();

        const song = state.songs.find(item => item.name === name);
        state.song = name;
        state.songReady = false;
        state.notes = [];
        $("#song-title").textContent = song ? song.title : name;
        $("#roll-hint").hidden = true;
        $("#library").classList.remove("open");
        updatePlayButton();
        renderSongs();

        try {
            const query = "?song=" + encodeURIComponent(name);
            const [data] = await Promise.all([
                api("/api/simple/song_notes" + query),
                resume ? null : setSetting("learning_load_song", name),
            ]);
            if (state.song !== name) return;  // another song was picked meanwhile
            state.notes = data.notes;
            state.duration = data.duration;
            state.percentTimes = data.percent_times;

            // The engine parses the file in the background
            for (let attempt = 0; attempt < 240; attempt++) {
                const server = await refreshState();
                if (state.song !== name) return;
                if (server && server.learning.loading === 5) throw new Error("load");
                if (server && server.learning.loading === 4 && server.learning.song === name) break;
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (!resume) {
                // A passage chosen for the previous song makes no sense here
                if (learning().end_point !== 100) await setSetting("learning_end_point", 100);
                if (learning().start_point !== 0) await setSetting("learning_start_point", 0);
                await refreshState();
            }
            state.songReady = true;
            state.position = state.target = passageStart();
            $("#timeline").hidden = false;
            updatePlayButton();
            updateTimeline();
            if (resume && learning().running) setRunning(true);
            if ($("#sheet-toggle").checked) loadSheet();
        } catch (e) {
            if (state.song === name) {
                toast(t("load_failed"), true);
                clearSong();
            }
        }
    }

    async function startSession() {
        if (!state.songReady) return;
        state.userStopped = false;
        state.waiting = false;
        state.position = state.target = passageStart();
        $("#score").textContent = "0";
        $("#combo").textContent = "0";
        try {
            await setSetting("start_learning_song", "0");
            setRunning(true);
        } catch (e) {
            toast(t("error"), true);
        }
    }

    async function stopSession() {
        if (!state.running) return;
        state.userStopped = true;
        setRunning(false);
        await setSetting("stop_learning_song", "0").catch(() => {});
    }

    async function setLeds(on) {
        // Only send real changes: the engine remembers the previous colour on each switch-off
        if (!!learning().leds === on) return;
        await setSetting("change_left_led_active", String(on));
        await setSetting("change_right_led_active", String(on));
        refreshState();
    }

    // ------------------------------------------------------------ timeline

    let dragging = null;  // "start" | "end" while a passage handle is held

    function updateTimeline() {
        if (!state.duration) return;
        const fraction = time => Math.min(100, Math.max(0, time / state.duration * 100)) + "%";
        const start = passageStart();
        const end = passageEnd();
        $("#handle-start").style.left = fraction(start);
        $("#handle-end").style.left = fraction(end);
        $("#timeline-range").style.left = fraction(start);
        $("#timeline-range").style.width = Math.max(0, (end - start) / state.duration * 100) + "%";
    }

    function percentAt(clientX) {
        const box = $("#timeline-bar").getBoundingClientRect();
        const time = Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * state.duration;
        let best = 0;
        for (let p = 1; p <= 100; p++) {
            if (Math.abs(state.percentTimes[p] - time) < Math.abs(state.percentTimes[best] - time)) best = p;
        }
        return best;
    }

    function movePassage(which, percent) {
        const status = learning();
        if (which === "start") status.start_point = Math.min(percent, status.end_point - 2);
        else status.end_point = Math.max(percent, status.start_point + 2);
        status.start_point = Math.max(0, status.start_point);
        status.end_point = Math.min(100, status.end_point);
        updateTimeline();
        if (!state.running) state.position = state.target = passageStart();
    }

    function commitPassage(which) {
        const status = learning();
        const request = which === "start"
            ? setSetting("learning_start_point", Math.round(status.start_point))
            : setSetting("learning_end_point", Math.round(status.end_point));
        request.catch(() => toast(t("error"), true));
    }

    function bindHandle(which) {
        const handle = $("#handle-" + which);
        handle.addEventListener("pointerdown", event => {
            dragging = which;
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener("pointermove", event => {
            if (dragging === which) movePassage(which, percentAt(event.clientX));
        });
        const release = () => {
            if (dragging !== which) return;
            dragging = null;
            commitPassage(which);
        };
        handle.addEventListener("pointerup", release);
        handle.addEventListener("pointercancel", release);
        handle.addEventListener("keydown", event => {
            const step = {ArrowLeft: -1, ArrowRight: 1}[event.key];
            if (!step) return;
            event.preventDefault();
            const status = learning();
            movePassage(which, (which === "start" ? status.start_point : status.end_point) + step);
            commitPassage(which);
        });
    }

    // ----------------------------------------------------------- websocket

    function connectSocket() {
        const socket = new WebSocket(`ws://${location.hostname}:8765/learning`);
        socket.onopen = () => {
            state.socketOpen = true;
            socket.send("subscribe_keys");
            updateStatus(true);
        };
        socket.onclose = () => {
            state.socketOpen = false;
            state.pressed.clear();
            updateStatus(true);
            setTimeout(connectSocket, 2000);
        };
        socket.onmessage = event => handleMessage(String(event.data));
    }

    function handleMessage(data) {
        if (data.startsWith("midi_event")) {
            const match = /note_(on|off).*?note=(\d+) velocity=(\d+)/.exec(data);
            if (!match) return;
            const note = Number(match[2]);
            if (match[1] === "on" && Number(match[3]) > 0) state.pressed.add(note);
            else state.pressed.delete(note);
            return;
        }
        if (!isNaN(Number(data))) {
            onSongTime(Number(data));
            return;
        }
        let message;
        try { message = JSON.parse(data); } catch (e) { return; }

        switch (message.type) {
            case "learning_state":
                if (state.songReady) setRunning(message.running);
                break;
            case "learning_wait":
                state.waiting = message.waiting;
                $("#wait-chip").hidden = !message.waiting;
                break;
            case "score_update":
                $("#score").textContent = Math.round(message.score);
                $("#combo").textContent = message.combo;
                break;
            case "session_summary":
                // Summaries queue up on the server while no page is open: ignore those leftovers
                if (state.sessionOpen && !state.userStopped && learning().practice !== 2) showSummary(message);
                state.sessionOpen = false;
                break;
        }
    }

    // The engine announces the time of the next event, then waits for the player (if
    // needed) and for the delay leading to it. So each message means "we are now at the
    // previous time, heading to this one".
    function onSongTime(time) {
        if (!state.running) return;
        const previous = time < state.target ? time : state.target;  // going backwards: the loop restarted
        state.target = time;
        if (Math.abs(state.position - previous) > 0.25) state.position = previous;
    }

    function showSummary(summary) {
        $("#summary-score").textContent = $("#score").textContent;
        const grid = $("#summary-grid");
        grid.replaceChildren();
        const rows = [
            ["summary_mistakes_right", summary.mistakes_r_count],
            ["summary_mistakes_left", summary.mistakes_l_count],
            ["summary_late_right", summary.delay_r],
            ["summary_late_left", summary.delay_l],
        ];
        for (const [label, value] of rows) {
            grid.append(el("dt", {textContent: t(label)}), el("dd", {textContent: value || 0}));
        }
        $("#summary").showModal();
    }

    // ------------------------------------------------------- falling notes

    const canvas = $("#roll");
    const context = canvas.getContext("2d");
    const BLACK_SEMITONES = new Set([1, 3, 6, 8, 10]);
    const SECONDS_VISIBLE = 3.2;
    let keys = [];     // geometry of each key, indexed by MIDI note
    let rollSize = {width: 0, height: 0, keyboard: 0};
    let lastFrame = 0;

    function resizeRoll() {
        const box = canvas.parentElement.getBoundingClientRect();
        if (!box.width || !box.height) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(box.width * ratio);
        canvas.height = Math.round(box.height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        rollSize = {
            width: box.width,
            height: box.height,
            keyboard: Math.min(130, Math.max(64, box.height * 0.24)),
        };
        layoutKeys();
    }

    function layoutKeys() {
        const first = state.server ? state.server.first_note : 21;
        const count = state.server ? state.server.piano_keys : 88;
        const notes = Array.from({length: count}, (_, index) => first + index);
        const whiteWidth = rollSize.width / notes.filter(note => !BLACK_SEMITONES.has(note % 12)).length;
        const blackWidth = whiteWidth * 0.62;
        keys = [];
        let whiteIndex = 0;
        for (const note of notes) {
            if (BLACK_SEMITONES.has(note % 12)) {
                keys[note] = {black: true, x: whiteIndex * whiteWidth - blackWidth / 2, width: blackWidth};
            } else {
                keys[note] = {black: false, x: whiteIndex * whiteWidth, width: whiteWidth};
                whiteIndex++;
            }
        }
    }

    function drawFrame(now) {
        requestAnimationFrame(drawFrame);
        const elapsed = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        if ($("#view-practice").hidden || !rollSize.width) return;

        if (state.running && !state.waiting && state.position < state.target) {
            state.position = Math.min(state.target, state.position + elapsed * (learning().tempo || 100) / 100);
        }

        const {width, height, keyboard} = rollSize;
        const lane = height - keyboard;           // y of the keyboard line
        const scale = lane / SECONDS_VISIBLE;     // pixels per second
        const position = state.position;
        const hands = learning().hands;           // 0 both, 1 right, 2 left
        const sounding = new Map();               // note -> colour of the note crossing the line

        context.clearRect(0, 0, width, height);

        // Octave guides
        context.fillStyle = "rgba(255, 255, 255, 0.05)";
        keys.forEach((key, note) => {
            if (note % 12 === 0) context.fillRect(Math.round(key.x), 0, 1, lane);
        });

        for (const [note, start, duration, hand] of state.notes) {
            if (start > position + SECONDS_VISIBLE) break;
            const end = start + duration;
            if (end < position) continue;
            const key = keys[note];
            if (!key) continue;

            const bottom = lane - (start - position) * scale;
            const top = Math.max(-8, lane - (end - position) * scale);
            const mine = hands === 0 || hand === 0 || hand === hands;
            const inset = key.black ? 0 : key.width * 0.12;

            context.globalAlpha = mine ? 1 : 0.3;
            context.fillStyle = state.colors[hand];
            context.beginPath();
            context.roundRect(key.x + inset, top, key.width - inset * 2, Math.max(3, Math.min(bottom, lane) - top), 4);
            context.fill();
            if (start <= position + 0.02 && mine) sounding.set(note, state.colors[hand]);
        }
        context.globalAlpha = 1;

        // Keyboard
        const blackHeight = keyboard * 0.62;
        const paint = (key, note, y, keyHeight, idle) => {
            context.fillStyle = state.pressed.has(note) ? "#f2b544" : (sounding.get(note) || idle);
            context.beginPath();
            context.roundRect(key.x + 0.5, y, key.width - 1, keyHeight, [0, 0, 3, 3]);
            context.fill();
        };
        keys.forEach((key, note) => { if (!key.black) paint(key, note, lane, keyboard, "#f1efe9"); });
        keys.forEach((key, note) => { if (key.black) paint(key, note, lane, blackHeight, "#1a1b20"); });

        context.fillStyle = state.waiting ? "#f2b544" : "rgba(255, 255, 255, 0.35)";
        context.fillRect(0, lane - 2, width, 2);

        if (state.duration) {
            $("#timeline-progress").style.left = Math.min(100, position / state.duration * 100) + "%";
            $("#timeline-time").textContent = clock(position) + " / " + clock(state.duration);
            followSheet(position / state.duration);
        }
    }

    // --------------------------------------------------------- sheet music

    const SHEET_SCRIPTS = ["/static/jquery-1.11.1.min.js", "/static/xml2abc.js", "/static/abc2svg-1.js"];
    let scriptsLoading = null;
    let sheetSong = null;

    function loadScripts() {
        scriptsLoading = scriptsLoading || SHEET_SCRIPTS.reduce((chain, source) => chain.then(() =>
            new Promise((resolve, reject) => {
                document.head.append(el("script", {src: source, onload: resolve, onerror: reject}));
            })), Promise.resolve());
        return scriptsLoading;
    }

    function sheetMessage(key) {
        $("#sheet-panel").replaceChildren(el("p", {class: "sheet-message", textContent: t(key)}));
    }

    async function loadSheet() {
        const panel = $("#sheet-panel");
        const name = state.song;
        panel.hidden = !name;
        if (!name || sheetSong === name) return;
        sheetMessage("sheet_loading");
        try {
            const [sheet] = await Promise.all([
                api("/api/simple/sheet?song=" + encodeURIComponent(name)),
                loadScripts(),
            ]);
            if (state.song !== name) return;

            let abc = sheet.data;
            if (sheet.format === "xml") {
                abc = window.vertaal(window.$.parseXML(sheet.data), {p: "f", t: 1, u: 0, v: 3, mnum: 0})[0];
            }
            let svg = "";
            const renderer = new window.abc2svg.Abc({
                img_out: part => { svg += part; },
                errmsg: () => {},
                read_file: () => "",
            });
            const pageWidth = Math.max(480, Math.round(panel.clientWidth - 24));
            renderer.tosvg("sheet", `%%pagewidth ${pageWidth}px\n%%leftmargin 8px\n%%rightmargin 8px\n` + abc);
            if (!svg.includes("<svg")) throw new Error("empty sheet");
            panel.innerHTML = svg;
            sheetSong = name;
        } catch (e) {
            if (state.song === name) sheetMessage("sheet_missing");
        }
    }

    // The sheet is not synchronised note by note: it scrolls along with the progress
    function followSheet(fraction) {
        const panel = $("#sheet-panel");
        if (panel.hidden || !state.running) return;
        const wanted = Math.round(fraction * (panel.scrollHeight - panel.clientHeight));
        if (Math.abs(panel.scrollTop - wanted) > 2) panel.scrollTop = wanted;
    }

    // ---------------------------------------------------------------- Wi-Fi

    function mountWifi(container) {
        const status = el("p", {class: "notice"});
        const message = el("p", {class: "notice", hidden: true});
        const list = el("ul", {class: "net-list net-scroll"});
        const scanButton = el("button", {class: "btn btn-small", textContent: t("wifi_scan"), onclick: scan});
        const disconnectButton = el("button", {
            class: "btn btn-small", textContent: t("wifi_disconnect"), hidden: true,
            onclick: async () => {
                await setSetting("disconnect_wifi", "0").catch(() => {});
                scan();
            },
        });
        container.replaceChildren(el("div", {class: "stack"},
            status, message, list, el("div", {class: "row"}, scanButton, disconnectButton)));

        let current = {};

        function say(text, bad) {
            message.textContent = text;
            message.classList.toggle("bad", !!bad);
            message.hidden = !text;
        }

        async function connect(ssid, password) {
            say(t(current.hotspot ? "wifi_switching" : "wifi_connecting", {ssid}));
            try {
                const result = await setSetting("connect_to_wifi", ssid, password);
                if (result.success) {
                    say("");
                    scan();
                } else {
                    say(t("wifi_failed", {ssid}), true);
                }
            } catch (e) {
                // The piano changed network under our feet: this page cannot reach it anymore
                say(t("wifi_switching", {ssid}));
            }
        }

        async function scan() {
            scanButton.disabled = true;
            list.replaceChildren(el("li", {class: "help", textContent: t("wifi_scanning")}));
            try {
                current = await api("/api/simple/wifi");
            } catch (e) {
                current = {networks: []};
            }
            scanButton.disabled = false;
            status.textContent = current.connected ? t("wifi_connected_to", {ssid: current.ssid})
                : t(current.hotspot ? "wifi_hotspot" : "wifi_not_connected");
            disconnectButton.hidden = !current.connected;
            list.replaceChildren();
            if (!current.networks.length) {
                list.append(el("li", {class: "help", textContent: t("wifi_none")}));
            }
            for (const network of current.networks) {
                const isCurrent = current.connected && network.ssid === current.ssid;
                const password = el("input", {
                    class: "field", type: "password", placeholder: t("wifi_password"),
                    autocomplete: "off", "aria-label": t("wifi_password"),
                });
                const form = el("form", {
                    class: "net-form", hidden: true,
                    onsubmit: event => {
                        event.preventDefault();
                        connect(network.ssid, password.value);
                    },
                }, password, el("button", {class: "btn btn-primary", textContent: t("wifi_connect")}));
                const head = el("button", {
                    class: "net-head",
                    onclick: () => {
                        if (isCurrent) return;
                        form.hidden = !form.hidden;
                        if (!form.hidden) password.focus();
                    },
                }, el("span", {class: "name", textContent: network.ssid}),
                    el("span", {class: "meta", textContent: isCurrent ? "✓" : network.signal + "%"}));
                list.append(el("li", {class: "net-item" + (isCurrent ? " current" : "")}, head, form));
            }
        }

        scan();
    }

    // ---------------------------------------------------------------- piano

    function mountPiano(container) {
        const list = el("ul", {class: "net-list"});
        const refresh = el("button", {class: "btn btn-small", textContent: t("piano_refresh"), onclick: render});
        container.replaceChildren(el("div", {class: "stack"},
            el("p", {class: "help", textContent: t("piano_help")}), list, el("div", {class: "row"}, refresh)));

        // "Roland FP-30:Roland FP-30 MIDI 1 20:0" -> "Roland FP-30"
        const deviceName = port => port.split(":")[0];

        async function render() {
            const server = await refreshState();
            const ports = server ? server.ports.filter(isRealPort) : [];
            list.replaceChildren();
            if (!ports.length) {
                list.append(el("li", {class: "notice", textContent: t("piano_none")}));
                return;
            }
            const selected = ports.includes(server.piano_port) ? server.piano_port
                : ports.find(port => deviceName(port) === deviceName(server.piano_port || ""));
            for (const port of ports) {
                const inUse = port === selected;
                list.append(el("li", {class: "net-item" + (inUse ? " current" : "")},
                    el("div", {class: "net-head"},
                        el("span", {class: "name", textContent: deviceName(port)}),
                        inUse ? el("span", {class: "meta", textContent: t("piano_in_use")})
                            : el("button", {
                                class: "btn btn-small", textContent: t("piano_use"),
                                onclick: async () => {
                                    await setSetting("piano_port", port).catch(() => toast(t("error"), true));
                                    render();
                                },
                            }))));
            }
        }

        render();
    }

    // ------------------------------------------------------- form helpers

    function saveSetting(name, value, flash) {
        return setSetting(name, value)
            .then(() => { if (flash) flashReferenceKeys(); })
            .catch(() => toast(t("error"), true));
    }

    function formRow(label, control, help) {
        return el("div", {class: "stack-tight"},
            el("label", {class: "form-row"}, el("span", {textContent: t(label)}), control),
            help ? el("p", {class: "help", textContent: t(help)}) : null);
    }

    // options: plain values, or [value, label] pairs
    function selectField(options, selected, onchange) {
        const node = el("select", {class: "field", onchange: () => onchange(node.value)});
        const pairs = options.map(option => (Array.isArray(option) ? option : [option, option]));
        if (!pairs.some(([value]) => String(value) === String(selected))) pairs.unshift([selected, selected]);
        for (const [value, label] of pairs) {
            node.append(el("option", {value, textContent: label, selected: String(value) === String(selected)}));
        }
        return node;
    }

    function numberField(value, onchange) {
        const input = el("input", {class: "field", type: "number", value, onchange: () => onchange(Number(input.value))});
        return input;
    }

    function rangeField(value, min, max, onchange) {
        const input = el("input", {type: "range", min, max, value});
        input.addEventListener("change", () => onchange(input.value));
        return input;
    }

    // ------------------------------------------------------ LED alignment

    const KEYBOARD_SIZES = [88, 76, 73, 61, 49];
    const LED_DENSITIES = [60, 72, 100, 120, 144, 160, 180, 200];
    const LED_PINS = ["12", "13", "18", "19", "41", "45", "53"];

    function flashReferenceKeys() {
        const first = state.server.first_note;
        const last = first + state.server.piano_keys - 1;
        postJson("/api/simple/test_leds", {notes: [first, 60, last]}).catch(() => {});
    }

    function mountAlignment(container) {
        if (!state.server) return;
        const leds = state.server.leds;

        const shiftInput = numberField(leds.shift, value => saveSetting("shift", Math.round(value), true));
        const nudge = step => {
            shiftInput.value = Number(shiftInput.value) + step;
            saveSetting("shift", shiftInput.value, true);
        };
        const reverse = el("input", {type: "checkbox", checked: !!leds.reverse});
        reverse.addEventListener("change", () => saveSetting("reverse", reverse.checked ? 1 : 0, true));

        const sizes = KEYBOARD_SIZES.map(n => [n, t("led_keys_option", {n})]);
        container.replaceChildren(el("div", {class: "form"},
            formRow("led_keys", selectField(sizes, state.server.piano_keys, async value => {
                await postJson("/api/simple/setup", {piano_keys: Number(value), apply_layout: true})
                    .catch(() => toast(t("error"), true));
                await refreshState();
                layoutKeys();
                mountAlignment(container);
                flashReferenceKeys();
            })),
            formRow("led_shift", el("span", {class: "stepper"},
                el("button", {class: "btn", textContent: "−", "aria-label": "-1", onclick: () => nudge(-1)}),
                shiftInput,
                el("button", {class: "btn", textContent: "+", "aria-label": "+1", onclick: () => nudge(1)})), "led_shift_help"),
            el("label", {class: "switch switch-row"}, el("span", {textContent: t("led_reverse")}), reverse, el("span", {class: "track"})),
            el("div", {class: "stack-tight"},
                el("button", {class: "btn", textContent: t("led_test"), onclick: flashReferenceKeys}),
                el("p", {class: "help", textContent: t("led_test_help")}))));
    }

    function mountHardware(container) {
        if (!state.server) return;
        const leds = state.server.leds;
        const offsets = leds.note_offsets.map(pair => pair.slice());
        const offsetList = el("div", {class: "offsets"});

        const saveOffsets = () => postJson("/api/simple/note_offsets", {offsets})
            .then(() => { state.server.leds.note_offsets = offsets; })
            .catch(() => toast(t("error"), true));

        function renderOffsets() {
            offsetList.replaceChildren();
            offsets.forEach((pair, index) => {
                const input = position => {
                    const node = el("input", {class: "field", type: "number", value: pair[position]});
                    node.addEventListener("change", () => {
                        pair[position] = Math.round(Number(node.value)) || 0;
                        saveOffsets();
                    });
                    return node;
                };
                offsetList.append(el("div", {class: "offset-row"},
                    el("span", {textContent: t("offsets_from")}), input(0),
                    el("span", {textContent: t("offsets_by")}), input(1),
                    el("span", {textContent: t("offsets_leds")}),
                    el("button", {
                        class: "btn btn-small", textContent: t("remove"),
                        onclick: () => {
                            offsets.splice(index, 1);
                            saveOffsets();
                            renderOffsets();
                        },
                    })));
            });
            offsetList.append(el("div", {}, el("button", {
                class: "btn btn-small", textContent: t("offsets_add"),
                onclick: () => {
                    offsets.push([60, 1]);
                    saveOffsets();
                    renderOffsets();
                },
            })));
        }
        renderOffsets();

        const pin = selectField(LED_PINS, leds.pin, async value => {
            if (await askConfirm(t("led_pin_confirm"))) {
                saveSetting("led_pin", value);
                toast(t("action_sent"));
            } else {
                pin.value = leds.pin;
            }
        });

        container.replaceChildren(el("div", {class: "form"},
            formRow("led_count", numberField(leds.count, value => saveSetting("led_count", Math.max(1, Math.round(value))))),
            formRow("led_per_meter", selectField(LED_DENSITIES, leds.per_meter, value => saveSetting("leds_per_meter", value, true))),
            formRow("led_pin", pin),
            el("div", {class: "stack-tight"},
                el("h3", {textContent: t("offsets")}),
                el("p", {class: "help", textContent: t("offsets_help")}),
                offsetList)));
    }

    // -------------------------------------------------------------- lights

    const COLOR_MODES = ["Single", "Rainbow", "VelocityRainbow", "Gradient", "Scale", "Speed", "Multicolor"];
    const LIGHT_MODES = ["Normal", "Fading", "Velocity", "Pedal", "Pulse"];
    const LIGHT_DURATION_SETTING = {
        Fading: "fading_speed", Velocity: "velocity_speed", Pedal: "pedal_speed", Pulse: "pulse_animation_speed",
    };
    const LIGHT_DURATIONS = [200, 500, 1000, 2000, 3000, 5000, 8000, 10000];
    const seconds = milliseconds => t("seconds", {n: (milliseconds / 1000).toLocaleString(simpleLanguage())});

    // options.modes: also offer the colour modes (settings page); the wizard only asks for a colour
    function mountColor(container, options) {
        if (!state.server) return;
        const leds = state.server.leds;
        const lights = state.server.lights;
        const rows = [];

        if (options && options.modes) {
            rows.push(formRow("color_mode", selectField(
                COLOR_MODES.map(mode => [mode, t("color_mode_" + mode)]), lights.color_mode, async value => {
                    lights.color_mode = value;
                    await saveSetting("color_mode", value);
                    mountColor(container, options);
                }), "color_mode_help_" + lights.color_mode));
        }
        if (!(options && options.modes) || lights.color_mode === "Single") {
            const picker = el("input", {class: "field", type: "color", value: leds.color});
            picker.addEventListener("change", async () => {
                leds.color = picker.value;
                lights.color_mode = "Single";  // choosing a colour switches to the single colour mode
                await saveSetting("led_color", picker.value.slice(1));
            });
            rows.push(formRow("led_color", picker));
        }
        rows.push(formRow("led_brightness", rangeField(leds.brightness, 1, 100, value => {
            leds.brightness = Number(value);
            saveSetting("brightness", value);
        })));
        container.replaceChildren(el("div", {class: "form"}, ...rows));
    }

    function mountLightMode(container) {
        if (!state.server) return;
        const lights = state.server.lights;
        const rows = [formRow("light_mode", selectField(
            LIGHT_MODES.map(mode => [mode, t("light_mode_" + mode)]), lights.mode, async value => {
                lights.mode = value;
                await saveSetting("light_mode", value);
                mountLightMode(container);
            }), "light_mode_help_" + lights.mode)];

        const setting = LIGHT_DURATION_SETTING[lights.mode];
        if (setting) {
            rows.push(formRow("light_duration", selectField(
                LIGHT_DURATIONS.map(ms => [ms, seconds(ms)]), lights.durations[lights.mode], value => {
                    lights.durations[lights.mode] = Number(value);
                    saveSetting(setting, value);
                })));
        }
        container.replaceChildren(el("div", {class: "form"}, ...rows));
    }

    function mountAnimations(container) {
        if (!state.server) return;
        const animations = state.server.animations;
        const run = name => api("/api/start_animation?name=" + encodeURIComponent(name))
            .catch(() => toast(t("error"), true));

        const preview = selectField(animations.list.map(item => [item.id, item.label]),
            animations.running || (animations.list[0] || {}).id, () => {});
        const startButton = el("button", {
            class: "btn btn-primary", textContent: t("animation_start"),
            onclick: async () => {
                await run(preview.value);
                animations.running = preview.value;
                stopButton.disabled = false;
            },
        });
        const stopButton = el("button", {
            class: "btn", textContent: t("animation_stop"), disabled: !animations.running,
            onclick: async () => {
                await run("stop");
                animations.running = null;
                stopButton.disabled = true;
            },
        });

        const delays = [0, 1, 2, 5, 10, 15, 30, 60].map(minutes =>
            [minutes, minutes ? t("minutes", {n: minutes}) : t("never")]);
        const idleRows = [formRow("animation_idle_delay", selectField(delays, animations.idle_delay, async value => {
            animations.idle_delay = Number(value);
            await saveSetting("animation_delay", value);
            mountAnimations(container);
        }), "animation_idle_help")];
        if (animations.idle_delay > 0) {
            idleRows.push(
                formRow("animation_idle", selectField(animations.list.map(item => [item.name, item.label]),
                    animations.idle, value => {
                        animations.idle = value;
                        saveSetting("led_animation", value);
                    })),
                formRow("led_brightness", rangeField(animations.idle_brightness, 1, 100, value => {
                    animations.idle_brightness = Number(value);
                    saveSetting("led_animation_brightness_percent", value);
                })));
        }

        container.replaceChildren(el("div", {class: "form"},
            el("div", {class: "stack-tight"},
                el("label", {class: "form-row"}, el("span", {textContent: t("animation_play")}), preview),
                el("div", {class: "row row-end"}, stopButton, startButton)),
            formRow("animation_speed", selectField(
                ["Slow", "Medium", "Fast"].map(speed => [speed, t("speed_" + speed)]), animations.speed, value => {
                    animations.speed = value;
                    api("/api/change_animation_speed?speed_value=" + encodeURIComponent(value))
                        .catch(() => toast(t("error"), true));
                })),
            el("hr", {}),
            ...idleRows));
    }

    // ------------------------------------------------------- settings page

    const SETTINGS_SECTIONS = ["connection", "lights", "strip", "system"];

    function showSettingsSection(name) {
        if (!SETTINGS_SECTIONS.includes(name)) name = SETTINGS_SECTIONS[0];
        remember("plv_settings_section", name);
        $$("#settings-nav button").forEach(button => button.setAttribute("aria-selected", button.dataset.section === name));
        $$(".settings-section").forEach(section => { section.hidden = section.dataset.section !== name; });

        if (name === "connection") {
            mountWifi($("#settings-wifi"));
            mountPiano($("#settings-piano"));
        } else if (name === "lights") {
            mountColor($("#settings-color"), {modes: true});
            mountLightMode($("#settings-light-mode"));
            mountAnimations($("#settings-animations"));
        } else if (name === "strip") {
            mountAlignment($("#settings-alignment"));
            mountHardware($("#settings-hardware"));
        }
    }

    // ---------------------------------------------------------------- debug

    function formatBytes(bytes) {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let index = 0;
        while (bytes >= 1024 && index < units.length - 1) {
            bytes /= 1024;
            index++;
        }
        return bytes.toFixed(index > 1 ? 1 : 0) + " " + units[index];
    }

    async function loadStats() {
        let data;
        try {
            data = await api("/api/get_homepage_data");
        } catch (e) {
            return;
        }
        const tiles = [
            ["stat_cpu", Math.round(data.cpu_usage) + " %", data.cpu_count + " × " + Math.round(data.cpu_freq) + " MHz"],
            ["stat_temp", data.cpu_temp + " °C", ""],
            ["stat_ram", Math.round(data.memory_usage_percent) + " %",
                formatBytes(data.memory_usage_used) + " / " + formatBytes(data.memory_usage_total)],
            ["stat_disk", Math.round(data.card_space_percent) + " %",
                formatBytes(data.card_space_used) + " / " + formatBytes(data.card_space_total)],
            ["stat_fps", data.led_fps === null ? "–" : data.led_fps + " fps", ""],
            ["stat_state", String(data.system_state || "").replace(/_/g, " ").toLowerCase(), ""],
        ];
        $("#stats").replaceChildren(...tiles.map(([label, value, detail]) => el("div", {class: "stat"},
            el("div", {class: "label", textContent: t(label)}),
            el("div", {class: "value", textContent: value}),
            el("div", {class: "detail", textContent: detail}))));
    }

    async function loadLogs() {
        const box = $("#logs");
        const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        try {
            const text = await api("/api/get_logs?last_logs=" + $("#logs-lines").value);
            box.textContent = String(text).trim() || t("logs_empty");
        } catch (e) {
            return;
        }
        if (pinned) box.scrollTop = box.scrollHeight;
    }

    // --------------------------------------------------------------- wizard

    const WIZARD_STEPS = [
        {key: "wifi", mount: mountWifi},
        {key: "piano", mount: mountPiano},
        {
            key: "leds",
            mount: body => {
                const alignment = el("div", {});
                const color = el("div", {});
                body.replaceChildren(el("div", {class: "form"}, alignment, el("hr", {}), color));
                mountAlignment(alignment);
                mountColor(color);
            },
        },
        {key: "done", mount: body => body.replaceChildren()},
    ];
    const WIZARD_STORAGE = "plv_wizard_step";
    let wizardIndex = 0;

    function remember(key, value) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) { /* private browsing: the wizard simply restarts at the first step */ }
    }

    function recall(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function showWizardStep(index) {
        wizardIndex = Math.min(WIZARD_STEPS.length - 1, Math.max(0, index));
        remember(WIZARD_STORAGE, String(wizardIndex));
        const step = WIZARD_STEPS[wizardIndex];
        const last = wizardIndex === WIZARD_STEPS.length - 1;
        const total = WIZARD_STEPS.length - 1;

        $("#wizard-step").textContent = last ? t("wizard_title") : t("wizard_step", {n: wizardIndex + 1, total});
        $("#wizard-progress-fill").style.width = (wizardIndex / total * 100) + "%";
        $("#wizard-title").textContent = t(`wizard_${step.key}_title`);
        $("#wizard-text").textContent = t(`wizard_${step.key}_text`);
        $("#wizard-back").style.visibility = wizardIndex ? "visible" : "hidden";
        $("#wizard-next").textContent = t(last ? "wizard_finish" : "wizard_next");
        $("#wizard-skip").hidden = last;
        step.mount($("#wizard-body"));
    }

    function openWizard(index) {
        if (!$("#wizard").open) $("#wizard").showModal();
        showWizardStep(index);
    }

    async function closeWizard() {
        $("#wizard").close();
        remember(WIZARD_STORAGE, null);
        await postJson("/api/simple/setup", {setup_done: 1}).catch(() => {});
        await refreshState();
        layoutKeys();
        if (!$("#view-settings").hidden) showView("settings");
    }

    // ----------------------------------------------------------------- init

    function bindEvents() {
        $$(".tabs button").forEach(tab => tab.addEventListener("click", () => showView(tab.dataset.view)));
        window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

        $("#song-search").addEventListener("input", renderSongs);
        $("#upload-input").addEventListener("change", event => {
            uploadFiles(Array.from(event.target.files));
            event.target.value = "";
        });
        $("#library-toggle").addEventListener("click", () => $("#library").classList.toggle("open"));

        $("#record-start").addEventListener("click", () => recorderAction("start_recording"));
        $("#record-save").addEventListener("click", () => recorderAction("save_recording", "record_saved"));
        $("#record-cancel").addEventListener("click", () => recorderAction("cancel_recording"));

        $("#play-btn").addEventListener("click", () => (state.running ? stopSession() : startSession()));
        $$("#mode-seg button").forEach(button => button.addEventListener("click", async () => {
            learning().practice = Number(button.dataset.value);
            setSegment("mode-seg", button.dataset.value);
            updatePlayButton();
            await setSetting("change_practice", button.dataset.value).catch(() => toast(t("error"), true));
        }));
        $$("#hands-seg button").forEach(button => button.addEventListener("click", async () => {
            learning().hands = Number(button.dataset.value);
            setSegment("hands-seg", button.dataset.value);
            await setSetting("change_hands", button.dataset.value).catch(() => toast(t("error"), true));
        }));
        $("#tempo").addEventListener("input", event => {
            learning().tempo = Number(event.target.value);
            $("#tempo-value").textContent = event.target.value + "%";
        });
        $("#tempo").addEventListener("change", event =>
            setSetting("change_tempo", event.target.value).catch(() => toast(t("error"), true)));
        $("#leds-toggle").addEventListener("change", event => setLeds(event.target.checked));
        $("#loop-toggle").addEventListener("change", event => {
            learning().loop = event.target.checked ? 1 : 0;
            setSetting("change_learning_loop", String(event.target.checked)).catch(() => toast(t("error"), true));
        });
        $("#sheet-toggle").addEventListener("change", event => {
            remember("plv_sheet", event.target.checked ? "1" : "0");
            if (event.target.checked) loadSheet();
            else $("#sheet-panel").hidden = true;
            resizeRoll();
        });
        bindHandle("start");
        bindHandle("end");

        $("#summary-close").addEventListener("click", () => $("#summary").close());
        $("#summary-again").addEventListener("click", () => {
            $("#summary").close();
            startSession();
        });

        $$("[data-system]").forEach(button => button.addEventListener("click", async () => {
            if (!await askConfirm(t(button.dataset.confirm || "confirm_restart_visualizer"))) return;
            setSetting(button.dataset.system, "0").catch(() => {});
            toast(t("action_sent"));
        }));
        const language = $("#language");
        for (const [code, name] of Object.entries(SIMPLE_LANGUAGES)) {
            language.append(el("option", {value: code, textContent: name, selected: code === simpleLanguage()}));
        }
        language.addEventListener("change", () => {
            setSimpleLanguage(language.value);
            location.reload();
        });
        $("#rerun-wizard").addEventListener("click", () => openWizard(0));
        $$("#settings-nav button").forEach(button =>
            button.addEventListener("click", () => showSettingsSection(button.dataset.section)));

        $$("#logs-lines option").forEach(option => { option.textContent = t("logs_lines", {n: option.value}); });
        $("#logs-lines").addEventListener("change", loadLogs);
        $("#logs-refresh").addEventListener("click", loadLogs);
        $("#logs-copy").addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText($("#logs").textContent);
                toast(t("logs_copied"));
            } catch (e) {
                toast(t("error"), true);
            }
        });

        $("#wizard").addEventListener("cancel", event => event.preventDefault());
        $("#wizard-skip").addEventListener("click", closeWizard);
        $("#wizard-back").addEventListener("click", () => showWizardStep(wizardIndex - 1));
        $("#wizard-next").addEventListener("click", () => {
            if (wizardIndex === WIZARD_STEPS.length - 1) closeWizard();
            else showWizardStep(wizardIndex + 1);
        });

        new ResizeObserver(resizeRoll).observe(canvas.parentElement);
    }

    async function init() {
        translatePage();
        bindEvents();
        $("#sheet-toggle").checked = recall("plv_sheet") === "1";
        updatePlayButton();

        await refreshState();
        showView(location.hash.slice(1));
        resizeRoll();
        requestAnimationFrame(drawFrame);
        connectSocket();
        await loadSongs();

        // Pick up a song that is already loaded (page reload, or started from the Pi's screen)
        const loaded = learning().song;
        if (loaded && state.songs.some(song => song.name === loaded)) selectSong(loaded, true);

        if (state.server && !state.server.setup_done) openWizard(Number(recall(WIZARD_STORAGE)) || 0);

        setInterval(() => { if (!dragging) refreshState(); }, 5000);
    }

    init();
})();
