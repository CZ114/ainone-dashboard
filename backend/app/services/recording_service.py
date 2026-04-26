"""
Recording Service - Handles CSV and WAV file recording
"""
import csv
import wave
import struct
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Union
import numpy as np

from app.config import RECORDINGS_DIR, CSV_DIR, AUDIO_DIR


class RecordingService:
    """Handles recording sensor data to CSV and audio to WAV"""

    def __init__(self, base_dir: Optional[Union[str, Path]] = None):
        # Default to the project-wide recordings dir from app.config so the
        # writer and the listing API always agree on one location, regardless
        # of which directory the backend is started from.
        self.base_dir = Path(base_dir) if base_dir is not None else RECORDINGS_DIR
        if base_dir is None:
            self.csv_dir = CSV_DIR
            self.audio_dir = AUDIO_DIR
        else:
            self.csv_dir = self.base_dir / "csv"
            self.audio_dir = self.base_dir / "audio"
        self.csv_dir.mkdir(parents=True, exist_ok=True)
        self.audio_dir.mkdir(parents=True, exist_ok=True)

        self.is_recording = False
        self.csv_file: Optional[object] = None
        self.csv_writer: Optional[csv.writer] = None
        self.csv_file_path: Optional[str] = None
        self.audio_frames: List[bytes] = []
        self.audio_file_path: Optional[str] = None
        self.start_time: Optional[datetime] = None
        self.duration: int = 60
        self.lock = threading.Lock()
        self.sample_rate = 16000
        self._recording_thread: Optional[threading.Thread] = None
        self._stop_recording_event = threading.Event()

    def start_recording(self, duration: int = 60, include_audio: bool = True,
                       channel_names: List[str] = None):
        """Start a new recording session"""
        with self.lock:
            self.is_recording = True
            self.start_time = datetime.now()
            self.duration = duration
            self.audio_frames = []
            self._stop_recording_event.clear()

            timestamp = self.start_time.strftime("%Y%m%d_%H%M%S")

            # Setup CSV writer
            if channel_names:
                self.csv_file_path = str(self.csv_dir / f"sensor_{timestamp}.csv")
                self.csv_file = open(self.csv_file_path, 'w', newline='', encoding='utf-8')
                self.csv_writer = csv.writer(self.csv_file)
                header = ['timestamp'] + channel_names
                self.csv_writer.writerow(header)
                self.csv_file_path = str(self.csv_file_path)

            # Setup audio path (file created on stop)
            if include_audio:
                self.audio_file_path = str(self.audio_dir / f"audio_{timestamp}.wav")

            print(f"[Recording] Started - Duration: {duration}s")

            # Start monitoring thread
            self._recording_thread = threading.Thread(target=self._monitor_recording, daemon=True)
            self._recording_thread.start()

    def _monitor_recording(self):
        """Monitor recording duration"""
        import time
        while self.is_recording and not self._stop_recording_event.is_set():
            elapsed = (datetime.now() - self.start_time).total_seconds() if self.start_time else 0
            if elapsed >= self.duration:
                self.stop_recording()
                break
            time.sleep(0.5)

    def write_sensor_row(self, timestamp: str, values: List[float]):
        """Write a single sensor data row"""
        if self.is_recording and self.csv_writer:
            self.csv_writer.writerow([timestamp] + [str(v) for v in values])
            # Periodic flush
            if hasattr(self, 'csv_file') and self.csv_file:
                self.csv_file.flush()

    def write_audio_frame(self, frame_data: bytes):
        """Write an audio frame"""
        if self.is_recording:
            self.audio_frames.append(frame_data)

    def stop_recording(self) -> dict:
        """Stop recording and finalize files"""
        with self.lock:
            self.is_recording = False
            self._stop_recording_event.set()

            # Finalize CSV
            if hasattr(self, 'csv_file') and self.csv_file:
                try:
                    self.csv_file.close()
                except Exception:
                    pass
                self.csv_file = None
                self.csv_writer = None

            # Finalize WAV
            if self.audio_frames:
                self._finalize_wav()

            elapsed = (datetime.now() - self.start_time).total_seconds() if self.start_time else 0
            result = {
                'elapsed_seconds': elapsed,
                'csv_path': getattr(self, 'csv_file_path', None),
                'audio_path': getattr(self, 'audio_file_path', None)
            }

            self.audio_frames = []
            print(f"[Recording] Stopped - Elapsed: {elapsed}s")

            return result

    def _finalize_wav(self):
        """Write accumulated audio data to WAV file"""
        if not self.audio_frames:
            return

        audio_path = getattr(self, 'audio_file_path', None)
        if not audio_path:
            return

        try:
            with wave.open(audio_path, 'wb') as wav:
                wav.setnchannels(1)  # Mono
                wav.setsampwidth(2)  # 16-bit
                wav.setframerate(self.sample_rate)
                for frame in self.audio_frames:
                    wav.writeframes(frame)
            print(f"[Recording] WAV saved: {audio_path}")
        except Exception as e:
            print(f"[Recording] WAV write error: {e}")

    def get_status(self) -> dict:
        """Get current recording status"""
        if not self.is_recording:
            return {
                'is_recording': False,
                'elapsed_seconds': 0,
                'remaining_seconds': 0,
                'csv_path': None,
                'audio_path': None
            }

        elapsed = (datetime.now() - self.start_time).total_seconds() if self.start_time else 0
        remaining = max(0, self.duration - elapsed)

        return {
            'is_recording': True,
            'elapsed_seconds': elapsed,
            'remaining_seconds': remaining,
            'csv_path': getattr(self, 'csv_file_path', None),
            'audio_path': getattr(self, 'audio_file_path', None)
        }

    def is_currently_recording(self) -> bool:
        return self.is_recording