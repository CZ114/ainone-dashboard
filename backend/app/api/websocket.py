"""
WebSocket API routes
"""
import asyncio
import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.extensions.manager import get_manager

router = APIRouter()


# BCP-47 → ISO 639-1 mapping for Whisper's `language` parameter. We
# only list codes we advertise in the frontend's VOICE_LANGS. Unknown
# codes map to None (auto-detect) so the extension stays flexible.
_BCP47_TO_WHISPER = {
    "en-US": "en",
    "en-GB": "en",
    "zh-CN": "zh",
    "zh-TW": "zh",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "es-ES": "es",
    "fr-FR": "fr",
    "de-DE": "de",
}


def bcp47_to_whisper(tag: str) -> str:
    """Return a 2-letter ISO code for Whisper, or empty string for auto."""
    if not tag:
        return ""
    if tag in _BCP47_TO_WHISPER:
        return _BCP47_TO_WHISPER[tag]
    # Fallback: split on "-" and take the primary subtag (e.g. "en-AU" → "en").
    primary = tag.split("-", 1)[0].lower()
    return primary if len(primary) == 2 else ""


def get_ws_manager():
    from app.main import get_ws_manager
    return get_ws_manager()


def get_conn_manager():
    from app.main import get_conn_manager
    return get_conn_manager()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time data streaming"""
    ws_manager = get_ws_manager()
    conn_manager = get_conn_manager()

    await ws_manager.connect(websocket)

    try:
        while True:
            data = await websocket.receive_text()

            try:
                message = json.loads(data)
                await handle_client_message(message, conn_manager, ws_manager)
            except json.JSONDecodeError:
                pass

    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


async def handle_client_message(message: dict, conn_manager, ws_manager):
    """Handle incoming WebSocket messages from client"""
    msg_type = message.get('type')

    if msg_type == 'set_channel_enabled':
        # Client wants to enable/disable a channel
        # This would update the channel state in connection manager
        pass

    elif msg_type == 'update_display_settings':
        # Client wants to update display settings
        settings = message.get('settings', {})
        if 'points_per_channel' in settings:
            conn_manager.set_waveform_points(settings['points_per_channel'])
        if 'cards_per_row' in settings:
            conn_manager.set_cards_per_row(settings['cards_per_row'])

    elif msg_type == 'zoom_channel':
        # Client wants to zoom a specific channel's Y-axis
        # This is handled client-side in the new architecture
        pass

    elif msg_type == 'request_status':
        # Client requests current connection status
        await ws_manager.broadcast({
            'type': 'connection_status',
            'serial': {
                'connected': conn_manager.serial_is_connected(),
                'port': conn_manager.serial_bridge.serial_port.port
                if conn_manager.serial_bridge.serial_port else None
            },
            'ble': {
                'connected': conn_manager.ble_is_connected()
            },
            'audio': {
                'connected': conn_manager.audio_is_connected()
            }
        })


@router.websocket("/ws/transcribe")
async def transcribe_endpoint(
    websocket: WebSocket,
    lang: str = Query("", description="Optional BCP-47 tag (e.g. en-US, zh-CN)"),
):
    """Live transcription of the ESP32 UDP audio stream via the
    Whisper-local extension. Accepts no client messages (beyond keep-
    alive); pushes `{kind: 'partial', text: '...'}` for each chunk.

    Query parameter `lang` (BCP-47) pins the transcription language on
    the model. Without it Whisper auto-detects each chunk, which is
    notoriously unstable on noisy audio (language flips every 3 s).

    Returns immediately with an error event if Whisper isn't running —
    the frontend should only offer the ESP32 mic option when the
    extension reports enabled=true, but this is a second defense.
    """
    await websocket.accept()

    ext = get_manager().get_instance("whisper-local")
    if ext is None:
        await websocket.send_json({
            "kind": "error",
            "message": "Whisper-local extension is not enabled. "
                       "Install/enable it from Settings.",
        })
        await websocket.close()
        return

    # Translate BCP-47 → ISO 639-1 and pin on the extension. Multiple
    # ws clients technically share one `_active_lang`; this is fine in
    # practice because one user = one open tab = one concurrent client.
    whisper_code = bcp47_to_whisper(lang)
    ext.set_active_lang(whisper_code or None)

    # Audio won't start flowing unless the Python backend is listening
    # on UDP 8888 AND the ESP32 is actually sending. We can't verify
    # the ESP32 from here, but we can remind the user about the audio
    # listener via a hint. The existing `/api/audio/start` endpoint
    # is what starts the listener; the frontend may need to nudge it.
    try:
        if not conn_manager_audio_connected():
            await websocket.send_json({
                "kind": "notice",
                "message": "UDP audio listener is not active. Start it from the "
                           "Dashboard (Audio → Connect) before speaking.",
            })
    except Exception:
        pass

    ext.add_ws_client(websocket)
    try:
        await websocket.send_json({"kind": "ready"})
        # Keep the connection alive. We don't expect client messages
        # today; anything sent is ignored. The receive_text() call
        # blocks until the client disconnects (which raises
        # WebSocketDisconnect) or sends data.
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
            except asyncio.TimeoutError:
                # Periodic ping so client + intermediaries stay healthy.
                await websocket.send_json({"kind": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[transcribe_ws] Error: {e}")
    finally:
        ext.remove_ws_client(websocket)


def conn_manager_audio_connected() -> bool:
    from app.main import get_conn_manager
    cm = get_conn_manager()
    return bool(cm and cm.audio_is_connected())