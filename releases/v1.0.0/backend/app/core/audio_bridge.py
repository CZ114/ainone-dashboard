r"""
Audio Bridge - UDP audio stream receiver from ESP32.
"""
import socket
import threading
import numpy as np
import struct
from typing import Optional, Callable


class AudioBridge:
    """UDP audio stream receiver"""

    def __init__(self):
        self.socket: Optional[socket.socket] = None
        self.is_connected = False
        self.running = False
        self.read_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Audio stats
        self.rms_db: float = -100.0
        self.peak_db: float = -100.0
        self.sample_rate = 16000

        # Callbacks
        self.on_audio_data: Optional[Callable] = None
        self.on_level_update: Optional[Callable] = None
        self.on_connection_change: Optional[Callable] = None

        # Extra audio-frame subscribers. Extensions (e.g. Whisper) tap
        # in here without replacing the recording service's existing
        # `on_audio_data` slot. Each subscriber runs on the UDP reader
        # thread; heavy work must be dispatched to its own loop/thread.
        self._audio_consumers: list[Callable] = []

    def start(self, port: int = 8888) -> bool:
        """Start UDP audio listener"""
        if self.running:
            self.stop()

        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.socket.bind(('0.0.0.0', port))
            self.socket.settimeout(0.5)

            self.running = True
            self.is_connected = True
            self._stop_event.clear()

            self.read_thread = threading.Thread(target=self._read_loop, name="AudioUDP", daemon=True)
            self.read_thread.start()

            if self.on_connection_change:
                self.on_connection_change(True, port)

            print(f"[Audio] UDP listener started on port {port}")
            return True

        except Exception as e:
            print(f"[Audio] Start error: {e}")
            self.is_connected = False
            return False

    def stop(self):
        """Stop UDP audio listener"""
        self.running = False
        self._stop_event.set()

        if self.read_thread and self.read_thread.is_alive():
            self.read_thread.join(timeout=2.0)

        if self.socket:
            try:
                self.socket.close()
            except Exception:
                pass

        self.socket = None
        self.is_connected = False
        self.rms_db = -100.0
        self.peak_db = -100.0

        if self.on_connection_change:
            self.on_connection_change(False)

        print("[Audio] Stopped")

    def _read_loop(self):
        """Background thread for reading UDP audio data"""
        buffer = bytearray()

        while self.running and not self._stop_event.is_set():
            try:
                if self.socket:
                    data, addr = self.socket.recvfrom(4096)
                    if data:
                        buffer.extend(data)

                        # Process complete frames (assuming 16-bit mono audio)
                        while len(buffer) >= 256:  # Process in chunks
                            frame = bytes(buffer[:256])
                            del buffer[:256]

                            # Calculate RMS and peak
                            self._process_audio_frame(frame)

                            # Callback with raw audio
                            if self.on_audio_data:
                                self.on_audio_data(frame)

                            # Fan-out to extra subscribers. Errors from
                            # one subscriber must not kill the loop or
                            # starve the others.
                            for cb in self._audio_consumers:
                                try:
                                    cb(frame)
                                except Exception as e:
                                    print(f"[Audio] Consumer error: {e}")

            except socket.timeout:
                continue
            except Exception as e:
                print(f"[Audio] Read error: {e}")
                break

        self.is_connected = False

    def _process_audio_frame(self, frame: bytes):
        """Process audio frame and calculate levels"""
        try:
            # Unpack 16-bit samples
            samples = struct.unpack(f'{len(frame) // 2}h', frame)
            samples = np.array(samples, dtype=np.float32) / 32768.0

            # Calculate RMS
            rms = np.sqrt(np.mean(samples ** 2))
            self.rms_db = 20 * np.log10(rms + 1e-10)

            # Calculate peak
            peak = np.max(np.abs(samples))
            self.peak_db = 20 * np.log10(peak + 1e-10)

            # Callback for level update
            if self.on_level_update:
                self.on_level_update(self.rms_db, self.peak_db)

        except Exception as e:
            print(f"[Audio] Process error: {e}")

    def get_levels(self) -> tuple:
        """Get current audio levels"""
        return self.rms_db, self.peak_db

    def add_audio_consumer(self, cb: Callable) -> None:
        """Subscribe to raw audio frames. Called synchronously on the
        UDP reader thread for every decoded frame; do the minimum
        possible work here and hand off to a worker / event loop."""
        if cb not in self._audio_consumers:
            self._audio_consumers.append(cb)

    def remove_audio_consumer(self, cb: Callable) -> None:
        try:
            self._audio_consumers.remove(cb)
        except ValueError:
            pass