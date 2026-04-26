"""
Connection Manager - Manages all sensor connections and data processing
"""
import asyncio
import threading
import time
from typing import Optional
import queue

from app.core.serial_bridge import SerialBridge
from app.core.ble_bridge import BLEBridge
from app.core.audio_bridge import AudioBridge
from app.core.data_processor import DataProcessor
from app.services.websocket_manager import WebSocketManager
from app.services.recording_service import RecordingService


class ConnectionManager:
    """Manages all connections: Serial, BLE, Audio"""

    def __init__(self, ws_manager: WebSocketManager):
        self.ws_manager = ws_manager

        # Initialize bridges
        self.serial_bridge = SerialBridge()
        self.ble_bridge = BLEBridge()
        self.audio_bridge = AudioBridge()

        # Initialize data processor
        self.data_processor = DataProcessor()

        # Initialize recording service. Wire the auto-stop callback
        # so the WS broadcast fires the moment the monitor thread ends
        # the session (rather than up to 1 s later on the next tick).
        self.recording_service = RecordingService()
        self.recording_service.on_status_changed = lambda: (
            self._broadcast_queue.put(('recording_status', None))
        )

        # State
        self.is_running = False
        self._poll_thread: Optional[threading.Thread] = None
        self._audio_level_thread: Optional[threading.Thread] = None

        # Message queue for passing data from threads to async context
        self._data_queue: queue.Queue = queue.Queue()
        self._broadcast_queue: queue.Queue = queue.Queue()

        # Settings
        self._waveform_points = 100
        self._cards_per_row = 4

        # Bind callbacks
        self._bind_callbacks()

    def _drain_data_queue(self, source: Optional[str] = None):
        """Drop pending data items so the UI stops receiving stale frames
        the moment a transport is disconnected.

        Without this, the dashboard would keep updating waveforms for a
        beat or two after the user clicks Disconnect — the bridge thread
        had already enqueued a final batch that the data loop was about
        to broadcast.
        """
        kept: list = []
        while True:
            try:
                item = self._data_queue.get_nowait()
            except queue.Empty:
                break
            # If `source` is set, only drop items from that transport so
            # disconnecting Serial doesn't also nuke pending BLE frames.
            if source is None or item[0] == source:
                continue
            kept.append(item)
        for item in kept:
            self._data_queue.put(item)

    def _bind_callbacks(self):
        """Bind callbacks for all bridges"""
        # Serial data callback - just put raw data in queue
        def on_serial_data(line: str):
            self._data_queue.put(('serial', line))

        self.serial_bridge.on_data = on_serial_data

        def on_serial_connect(connected: bool, port: str = None, baud: int = None):
            if not connected:
                # Wipe channel state so a stale narrow first-packet from
                # last session doesn't cap the channel count next time,
                # AND drop any in-flight serial frames so the dashboard
                # stops the instant the user clicks Disconnect.
                self.data_processor.reset()
                self._drain_data_queue(source='serial')
            self._broadcast_queue.put(('connection_status', None))

        self.serial_bridge.on_connection_change = on_serial_connect

        # BLE data callback
        def on_ble_data(values: list, raw_text: str = None):
            # Convert BLE data to CSV format and queue it
            csv_line = ','.join(str(v) for v in values)
            self._data_queue.put(('ble', csv_line))

        self.ble_bridge.on_data_update = on_ble_data

        def on_ble_connect(connected: bool, device: str = None):
            if not connected:
                self.data_processor.reset()
                self._drain_data_queue(source='ble')
            self._broadcast_queue.put(('connection_status', None))

        self.ble_bridge.on_connection_change = on_ble_connect

        # Audio callbacks
        def on_audio_connect(connected: bool, port: int = None):
            self._broadcast_queue.put(('connection_status', None))

        self.audio_bridge.on_connection_change = on_audio_connect

        def on_audio_level_update(rms_db: float, peak_db: float):
            self._broadcast_queue.put(('audio_level', None))

        self.audio_bridge.on_level_update = on_audio_level_update

        def on_audio_data(frame: bytes):
            if self.recording_service.is_recording:
                self.recording_service.write_audio_frame(frame)

        self.audio_bridge.on_audio_data = on_audio_data

    def start(self):
        """Start the connection manager"""
        self.is_running = True

        # Start data polling and broadcasting thread
        self._poll_thread = threading.Thread(target=self._data_loop, daemon=True)
        self._poll_thread.start()

        print("[ConnectionManager] Started")

    def stop(self):
        """Stop all connections"""
        self.is_running = False

        self.serial_bridge.disconnect()
        self.ble_bridge.stop()
        self.audio_bridge.stop()
        self.recording_service.stop_recording()

        print("[ConnectionManager] Stopped")

    def _data_loop(self):
        """Main loop that processes data and broadcasts from threads"""
        loop_count = 0
        while self.is_running:
            try:
                loop_count += 1

                # Process incoming data
                while not self._data_queue.empty():
                    try:
                        source, data = self._data_queue.get_nowait()
                        result = self.data_processor.process_csv_line(data)
                        if result:
                            self._broadcast_sensor_data_sync()
                    except queue.Empty:
                        break

                # Process broadcast requests
                while not self._broadcast_queue.empty():
                    try:
                        msg_type, _ = self._broadcast_queue.get_nowait()
                        if msg_type == 'connection_status':
                            self._broadcast_connection_status_sync()
                        elif msg_type == 'audio_level':
                            self._broadcast_audio_level_sync()
                        elif msg_type == 'recording_status':
                            self._broadcast_recording_status_sync()
                    except queue.Empty:
                        break

                # Broadcast recording status every ~1 second (50Hz * 1s)
                if loop_count % 50 == 0:
                    self._broadcast_recording_status_sync()

                time.sleep(0.02)  # ~50Hz
            except Exception as e:
                print(f"[Data Loop] Error: {e}")

    def _broadcast_sensor_data_sync(self):
        """Synchronously broadcast sensor data (called from thread)"""
        if not self.data_processor.channel_names:
            print("[Broadcast Sensor] No channel names yet")
            return

        try:
            message = {
                'type': 'sensor_data',
                'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S') + f'.{int(time.time() * 1000) % 1000:03d}Z',
                'channels': self.data_processor.get_channel_names(),
                'values': self.data_processor.get_latest_values(),
                'waveforms': [self.data_processor.get_waveforms(self._waveform_points).get(i, [])
                             for i in range(self.data_processor.get_channel_count())],
                'stats': self.data_processor.get_all_stats()
            }

            print(f"[Broadcast Sensor] Broadcasting {len(message['channels'])} channels: {message['channels']}")
            # Schedule broadcast in async context
            self.ws_manager.schedule_broadcast(message)

            # Write to recording if active
            if self.recording_service.is_recording:
                self.recording_service.write_sensor_row(
                    message['timestamp'],
                    message['values']
                )
        except Exception as e:
            print(f"[Broadcast Sensor] Error: {e}")

    def _broadcast_audio_level_sync(self):
        """Synchronously broadcast audio level (called from thread)"""
        try:
            rms_db, peak_db = self.audio_bridge.get_levels()
            status = self.recording_service.get_status()

            message = {
                'type': 'audio_level',
                'rms_db': float(rms_db),
                'peak_db': float(peak_db),
                'is_recording': status['is_recording']
            }

            self.ws_manager.schedule_broadcast(message)
        except Exception as e:
            print(f"[Audio Level] Error: {e}")

    def _broadcast_recording_status_sync(self):
        """Synchronously broadcast recording status (called from thread)"""
        try:
            status = self.recording_service.get_status()
            message = {
                'type': 'recording_status',
                'is_recording': status['is_recording'],
                'elapsed_seconds': status['elapsed_seconds'],
                'remaining_seconds': status['remaining_seconds'],
                'csv_path': status.get('csv_path'),
                'audio_path': status.get('audio_path')
            }
            self.ws_manager.schedule_broadcast(message)
        except Exception as e:
            print(f"[Recording Status] Error: {e}")

    def _broadcast_connection_status_sync(self):
        """Synchronously broadcast connection status (called from thread)"""
        try:
            status = {
                'type': 'connection_status',
                'serial': {
                    'connected': self.serial_bridge.is_connected,
                    'port': self.serial_bridge.serial_port.port if self.serial_bridge.serial_port else None,
                    'baud_rate': int(self.serial_bridge.serial_port.baudrate) if self.serial_bridge.serial_port else None
                },
                'ble': {
                    'connected': self.ble_bridge.is_connected,
                    'device_name': self.ble_bridge.device_name if self.ble_bridge.is_connected else None
                },
                'audio': {
                    'connected': self.audio_bridge.is_connected,
                    'port': getattr(self.audio_bridge, 'socket', None).getsockname()[1]
                    if self.audio_bridge.socket else None
                }
            }

            self.ws_manager.schedule_broadcast(status)
        except Exception as e:
            print(f"[Broadcast Status] Error: {e}")

    # Serial API
    def serial_connect(self, port: str, baud_rate: int = 115200) -> bool:
        return self.serial_bridge.connect(port, baud_rate)

    def serial_disconnect(self):
        self.serial_bridge.disconnect()

    def serial_list_ports(self) -> list:
        return self.serial_bridge.list_ports()

    def serial_is_connected(self) -> bool:
        return self.serial_bridge.is_connected

    # BLE API
    def ble_start_scan(self):
        self.ble_bridge.start_scan()

    def ble_stop(self):
        self.ble_bridge.stop()

    def ble_is_connected(self) -> bool:
        return self.ble_bridge.is_connected

    # Audio API
    def audio_start(self, port: int = 8888) -> bool:
        return self.audio_bridge.start(port)

    def audio_stop(self):
        self.audio_bridge.stop()

    def audio_is_connected(self) -> bool:
        return self.audio_bridge.is_connected

    # Recording API
    def recording_start(self, duration: int = 60, include_audio: bool = True) -> bool:
        self.recording_service.start_recording(
            duration=duration,
            include_audio=include_audio,
            channel_names=self.data_processor.get_channel_names()
        )
        # Immediately broadcast recording status
        self._broadcast_recording_status_sync()
        return True

    def recording_stop(self) -> dict:
        result = self.recording_service.stop_recording()
        # Immediately broadcast recording status
        self._broadcast_recording_status_sync()
        return result

    def recording_status(self) -> dict:
        return self.recording_service.get_status()

    # Settings
    def set_waveform_points(self, points: int):
        self._waveform_points = points
        self.data_processor.set_waveform_points(points)

    def set_cards_per_row(self, count: int):
        self._cards_per_row = count

    def get_settings(self) -> dict:
        return {
            'waveform_points': self._waveform_points,
            'cards_per_row': self._cards_per_row
        }