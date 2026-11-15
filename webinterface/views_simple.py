"""Endpoints for the simple interface (practice home page, settings, debug, setup wizard).

Everything that already has an endpoint in views_api.py is reused from there; this file
only adds what the simple interface needs in a JSON-friendly shape.
"""
import ast
import json
import os
import threading
import time

import mido
import webcolors as wc
from flask import jsonify, request

from lib.functions import fastColorWipe, get_note_position
from lib.log_setup import logger
from lib.rpi_drivers import Color
from webinterface import webinterface, app_state

SONGS_DIR = 'Songs'
SHEET_EXTENSIONS = ('.musicxml', '.xml', '.abc')

# Lowest MIDI note for the usual keyboard sizes
PIANO_FIRST_NOTE = {88: 21, 76: 28, 73: 28, 61: 36, 49: 36}


def _setting(name, default=None):
    value = app_state.usersettings.get_setting_value(name)
    return default if value is None else value


def _int_setting(name, default=0):
    try:
        return int(float(_setting(name, default)))
    except (TypeError, ValueError):
        return default


def _song_path(name):
    """Resolve a song name inside Songs/, refusing anything that points elsewhere."""
    if not name or os.path.basename(name) != name:
        return None
    path = os.path.join(SONGS_DIR, name)
    return path if os.path.isfile(path) else None


def _hand_color(index, fallback_index):
    colors = app_state.learning.hand_colorList
    try:
        rgb = colors[int(index)]
        if not any(rgb):  # "LEDs off" is stored as the black entry
            rgb = colors[int(fallback_index)]
    except (IndexError, ValueError, TypeError):
        rgb = [255, 255, 255]
    return wc.rgb_to_hex(tuple(int(c) for c in rgb))


def _learning_state():
    learning = app_state.learning
    return {
        "loading": learning.loading,
        "running": bool(learning.is_started_midi),
        "song": getattr(learning, 'current_song_name', None) if learning.loading == 4 else None,
        "practice": learning.practice,
        "hands": learning.hands,
        "tempo": learning.set_tempo,
        "loop": int(learning.is_loop_active),
        "start_point": learning.start_point,
        "end_point": learning.end_point,
        "leds": int(bool(learning.is_led_activeL) and bool(learning.is_led_activeR)),
        "color_right": _hand_color(learning.hand_colorR, learning.prev_hand_colorR),
        "color_left": _hand_color(learning.hand_colorL, learning.prev_hand_colorL),
    }


def _lights_state():
    return {
        "mode": _setting("mode", "Normal"),
        "color_mode": _setting("color_mode", "Single"),
        # how long the light takes to fade, per light mode (milliseconds)
        "durations": {
            "Fading": _int_setting("fadingspeed", 1000),
            "Velocity": _int_setting("velocity_speed", 3000),
            "Pedal": _int_setting("pedal_speed", 3000),
            "Pulse": _int_setting("pulse_animation_speed", 1000),
        },
    }


def _animations_state():
    # lib.led_animations pulls in lib.functions, keep it out of the import cycle
    from lib.led_animations import get_registry

    menu = app_state.menu
    running = None
    if getattr(menu, 'is_animation_running', False) or getattr(menu, 'is_idle_animation_running', False):
        running = getattr(menu, 'current_animation_name', None)

    return {
        # animations needing an extra parameter (chords, colormap) stay in the advanced interface
        "list": [{"id": info.web_id, "name": info.name, "label": info.display_name}
                 for info in get_registry().get_all() if not info.requires_param],
        "running": running,
        "speed": _setting("led_animation_speed", "Medium") or "Medium",
        "idle": _setting("led_animation", ""),
        "idle_delay": _int_setting("led_animation_delay"),
        "idle_brightness": _int_setting("led_animation_brightness_percent", 50),
    }


@webinterface.route('/api/simple/state', methods=['GET'])
def simple_state():
    piano_keys = _int_setting("piano_keys", 88)
    red, green, blue = (_int_setting(c) for c in ("red", "green", "blue"))

    try:
        ports = list(dict.fromkeys(mido.get_input_names()))
    except Exception as e:
        logger.warning(f"Could not list MIDI ports: {e}")
        ports = []

    try:
        note_offsets = ast.literal_eval(str(_setting("note_offsets", "[]")))
    except (ValueError, SyntaxError):
        note_offsets = []

    return jsonify({
        "setup_done": _int_setting("setup_done"),
        "piano_keys": piano_keys,
        "first_note": PIANO_FIRST_NOTE.get(piano_keys, 21),
        "ports": ports,
        "piano_port": _setting("piano_port", ""),
        "leds": {
            "color": wc.rgb_to_hex((red, green, blue)),
            "brightness": _int_setting("brightness_percent", 50),
            "count": _int_setting("led_count", 176),
            "per_meter": _int_setting("leds_per_meter", 144),
            "shift": _int_setting("shift"),
            "reverse": _int_setting("reverse"),
            "pin": str(_setting("led_pin", "18") or "18"),
            "note_offsets": note_offsets,
        },
        "lights": _lights_state(),
        "animations": _animations_state(),
        "learning": _learning_state(),
        "recording": bool(app_state.saving.is_recording),
    })


@webinterface.route('/api/simple/setup', methods=['POST'])
def simple_setup():
    data = request.get_json(silent=True) or {}

    if "piano_keys" in data:
        keys = int(data["piano_keys"])
        if keys not in PIANO_FIRST_NOTE:
            return jsonify(success=False, error="Unsupported keyboard size"), 400
        app_state.usersettings.change_setting_value("piano_keys", keys)

        if data.get("apply_layout"):
            # Line the strip up with the first key and size it to the keyboard
            density = app_state.ledstrip.leds_per_meter / 72
            app_state.ledstrip.change_led_count(int(round(keys * density)), True)
            app_state.ledstrip.change_shift(-int(round(density * (PIANO_FIRST_NOTE[keys] - 21))), True)

    if "setup_done" in data:
        app_state.usersettings.change_setting_value("setup_done", int(bool(data["setup_done"])))

    return jsonify(success=True)


@webinterface.route('/api/simple/note_offsets', methods=['POST'])
def simple_note_offsets():
    data = request.get_json(silent=True) or {}
    try:
        offsets = [[int(note), int(offset)] for note, offset in data.get("offsets", [])]
    except (TypeError, ValueError):
        return jsonify(success=False, error="Invalid offsets"), 400

    # get_note_position adds up every range a note falls in, highest first by convention
    offsets.sort(key=lambda pair: pair[0], reverse=True)
    app_state.ledsettings.note_offsets = offsets
    app_state.usersettings.change_setting_value("note_offsets", offsets)
    return jsonify(success=True, offsets=offsets)


def _flash_notes(notes, seconds):
    strip = app_state.ledstrip.strip
    positions = [get_note_position(note, app_state.ledstrip, app_state.ledsettings) for note in notes]
    positions = [p for p in positions if 0 <= p < app_state.ledstrip.led_number]
    try:
        fastColorWipe(strip, True, app_state.ledsettings)
        for position in positions:
            strip.setPixelColor(position, Color(255, 255, 255))
        strip.show()
        time.sleep(seconds)
        fastColorWipe(strip, True, app_state.ledsettings)
    except Exception as e:
        logger.warning(f"LED test failed: {e}")


@webinterface.route('/api/simple/test_leds', methods=['POST'])
def simple_test_leds():
    """Light the LEDs above a few keys so the alignment can be checked by eye."""
    data = request.get_json(silent=True) or {}
    try:
        notes = [int(n) for n in data.get("notes", [])][:12]
    except (TypeError, ValueError):
        return jsonify(success=False, error="Invalid notes"), 400
    if app_state.learning.is_started_midi:
        return jsonify(success=False, error="A practice session is running"), 409

    threading.Thread(target=_flash_notes, args=(notes, 4), daemon=True).start()
    return jsonify(success=True)


@webinterface.route('/api/simple/wifi', methods=['GET'])
def simple_wifi():
    networks, connected, ssid = [], False, ""
    try:
        networks = app_state.platform.get_wifi_networks() or []
        status = app_state.platform.get_current_connections()
        if status:
            connected, ssid = bool(status[0]), status[1]
    except Exception as e:
        logger.warning(f"Could not read Wi-Fi state: {e}")

    return jsonify({
        "networks": [{"ssid": n.get("ESSID", ""), "signal": int(n.get("Signal Strength", 0))}
                     for n in networks if n.get("ESSID")],
        "connected": connected,
        # when not connected the platform returns a status sentence instead of an SSID
        "ssid": ssid if connected else "",
        "hotspot": (not connected) and "hotspot" in str(ssid).lower(),
    })


# Folders are labels kept next to the songs: the files themselves stay flat in Songs/,
# which the learning engine, the cache and the advanced interface all rely on.
FOLDERS_FILE = os.path.join(SONGS_DIR, 'folders.json')


def _read_folders():
    try:
        with open(FOLDERS_FILE, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
        return {str(song): str(folder) for song, folder in data.items() if folder}
    except (OSError, ValueError, AttributeError):
        return {}


def _write_folders(folders):
    with open(FOLDERS_FILE, 'w', encoding='utf-8') as handle:
        json.dump(folders, handle, ensure_ascii=False, indent=1)


@webinterface.route('/api/simple/songs', methods=['GET'])
def simple_songs():
    folders = _read_folders()
    songs = []
    for name in os.listdir(SONGS_DIR):
        if "_#" in name or not name.lower().endswith('.mid'):
            continue
        path = os.path.join(SONGS_DIR, name)
        base = name[:-4]
        songs.append({
            "name": name,
            "title": base[:-5] if base.endswith("_main") else base,
            "folder": folders.get(name, ""),
            "date": os.path.getmtime(path),
        })
    songs.sort(key=lambda s: s["title"].lower())
    return jsonify(songs=songs)


@webinterface.route('/api/simple/song_folder', methods=['POST'])
def simple_song_folder():
    """Put a song in a folder; an empty folder name takes it out."""
    data = request.get_json(silent=True) or {}
    name = data.get("song")
    if not _song_path(name):
        return jsonify(success=False, error="Song not found"), 404
    folder = " ".join(str(data.get("folder") or "").split())[:60]

    # Drop entries of songs deleted since, so folders disappear with their last song
    folders = {song: label for song, label in _read_folders().items() if _song_path(song)}
    if folder:
        folders[name] = folder
    else:
        folders.pop(name, None)
    try:
        _write_folders(folders)
    except OSError as e:
        logger.warning(f"Could not save song folders: {e}")
        return jsonify(success=False, error="Could not save"), 500
    return jsonify(success=True, folder=folder)


@webinterface.route('/api/simple/song_notes', methods=['GET'])
def simple_song_notes():
    """Notes of a song on the same time axis the learning engine reports over the websocket."""
    path = _song_path(request.args.get('song'))
    if not path:
        return jsonify(success=False, error="Song not found"), 404

    # lib.learnmidi imports this package, so it cannot be imported at module level
    from lib.learnmidi import assign_hands

    try:
        mid = mido.MidiFile(path, clip=True)
        assign_hands(mid)

        ticks_per_beat = mid.ticks_per_beat or 480
        tempo = 500000
        elapsed = 0.0
        ticks = 0
        bar_ticks = ticks_per_beat * 4   # until a time signature says otherwise
        next_bar = 0
        message_times = []  # one entry per merged message, like LearnMIDI.song_tracks
        bars = []
        held = {}
        notes = []
        # Same walk as mido's own iteration (which the engine uses), keeping the ticks
        # so that bar lines can be placed
        for msg in mido.merge_tracks(mid.tracks):
            delta = mido.tick2second(msg.time, ticks_per_beat, tempo) if msg.time else 0.0
            # LearnMIDI.notes_time only advances on non-meta messages
            advance = 0.0 if msg.is_meta else delta
            while msg.time and next_bar <= ticks + msg.time:
                bars.append(round(elapsed + advance * (next_bar - ticks) / msg.time, 3))
                next_bar += bar_ticks
            ticks += msg.time
            elapsed += advance
            message_times.append(elapsed)

            if msg.type == 'set_tempo':
                tempo = msg.tempo
            elif msg.type == 'time_signature':
                bar_ticks = max(1, int(ticks_per_beat * 4 * msg.numerator / msg.denominator))
                next_bar = ticks + bar_ticks
            if msg.is_meta or msg.type not in ('note_on', 'note_off'):
                continue
            key = (msg.note, msg.channel)
            if msg.type == 'note_on' and msg.velocity > 0:
                held.setdefault(key, elapsed)
            elif key in held:
                start = held.pop(key)
                hand = msg.channel if msg.channel in (1, 2) else 0
                notes.append([msg.note, round(start, 3), round(max(elapsed - start, 0.05), 3), hand])
    except Exception as e:
        logger.warning(f"Could not read {path}: {e}")
        return jsonify(success=False, error="Unreadable MIDI file"), 422

    notes.sort(key=lambda n: n[1])
    count = len(message_times)
    # start_point / end_point are percentages of the message list, not of the duration
    percent_times = [round(message_times[min(int(p * count / 100), count - 1)], 3) if count else 0
                     for p in range(101)]

    return jsonify(success=True, notes=notes, duration=round(elapsed, 3),
                   percent_times=percent_times, bars=bars)


@webinterface.route('/api/simple/sheet', methods=['GET'])
def simple_sheet():
    name = request.args.get('song')
    if not _song_path(name):
        return jsonify(success=False, error="Song not found"), 404
    base = os.path.join(SONGS_DIR, name[:-4])

    if not any(os.path.isfile(base + ext) for ext in SHEET_EXTENSIONS):
        app_state.learning.convert_midi_to_abc(name)  # needs midi2abc on the Pi

    for ext in SHEET_EXTENSIONS:
        if os.path.isfile(base + ext):
            with open(base + ext, 'r', encoding='utf-8', errors='replace') as handle:
                return jsonify(success=True, format='abc' if ext == '.abc' else 'xml', data=handle.read())

    return jsonify(success=False, error="No sheet music available"), 404
