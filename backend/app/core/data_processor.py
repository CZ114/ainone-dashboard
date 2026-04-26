"""
Data Processor - RingBuffer and data processing for sensor channels
"""
import numpy as np
from collections import deque
from threading import Lock
from typing import List, Dict, Optional
from datetime import datetime


class RingBuffer:
    """Thread-safe ring buffer for waveform data"""

    def __init__(self, size: int = 100):
        self.size = size
        self.buffer = deque(maxlen=size)
        self.lock = Lock()

    def append(self, value: float):
        with self.lock:
            self.buffer.append(value)

    def get_all(self) -> List[float]:
        with self.lock:
            return list(self.buffer)

    def get_last(self, n: int) -> List[float]:
        with self.lock:
            return list(self.buffer)[-n:]


class ChannelProcessor:
    """Processes data for a single channel"""

    def __init__(self, name: str, index: int):
        self.name = name
        self.index = index
        self.ring_buffer = RingBuffer(100)
        self.latest_value: float = 0.0
        self.min_value: float = float('inf')
        self.max_value: float = float('-inf')
        self.sum_values: float = 0.0
        self.count: int = 0
        self.lock = Lock()

    def update(self, value: float):
        with self.lock:
            self.latest_value = value
            self.ring_buffer.append(value)
            self.min_value = min(self.min_value, value)
            self.max_value = max(self.max_value, value)
            self.sum_values += value
            self.count += 1

    def get_stats(self) -> Dict[str, float]:
        with self.lock:
            avg = self.sum_values / self.count if self.count > 0 else 0.0
            return {
                'min': self.min_value,
                'max': self.max_value,
                'avg': avg
            }

    def reset_stats(self):
        with self.lock:
            self.min_value = float('inf')
            self.max_value = float('-inf')
            self.sum_values = 0.0
            self.count = 0


class DataProcessor:
    """Main data processor managing all channels"""

    def __init__(self, max_channels: int = 16):
        self.channels: Dict[int, ChannelProcessor] = {}
        self.channel_names: List[str] = []
        self.lock = Lock()
        self.packet_count: int = 0
        self.max_channels = max_channels
        self._waveform_points = 100

    def set_waveform_points(self, points: int):
        self._waveform_points = points
        for ch in self.channels.values():
            ch.ring_buffer = RingBuffer(points)

    def process_csv_line(self, line: str) -> Optional[Dict]:
        """Parse CSV line and update channel data"""
        try:
            parts = [p.strip() for p in line.split(',') if p.strip()]
            if len(parts) < 2:
                return None

            with self.lock:
                # First time seeing data - detect header or initialize
                if not self.channel_names:
                    # Try to detect if header
                    numeric_count = sum(1 for p in parts if self._is_numeric(p))
                    if numeric_count / len(parts) < 0.5:
                        # Header row
                        self.channel_names = parts
                        self._init_channels()
                        return None
                    else:
                        # Data row without header
                        self.channel_names = [f"CH{i + 1}" for i in range(len(parts))]
                        self._init_channels()

                # Grow channel list when a wider row arrives. Common when
                # the very first CSV line was a truncated packet (cold-
                # start) and subsequent rows carry all columns. Capped at
                # `max_channels` to guard against runaway widths from a
                # garbled line.
                if len(parts) > len(self.channel_names) and len(self.channel_names) < self.max_channels:
                    existing = len(self.channel_names)
                    target = min(len(parts), self.max_channels)
                    for i in range(existing, target):
                        self.channel_names.append(f"CH{i + 1}")
                        self.channels[i] = ChannelProcessor(self.channel_names[i], i)
                    print(
                        f"[DataProcessor] Expanded channel count "
                        f"{existing} → {target} after seeing wider row "
                        f"({len(parts)} cols)"
                    )

                # Parse values
                values = []
                for p in parts:
                    try:
                        values.append(float(p))
                    except ValueError:
                        values.append(0.0)

                # Ensure column count matches
                while len(values) < len(self.channel_names):
                    values.append(0.0)
                values = values[:len(self.channel_names)]

                # Update channels
                timestamp = datetime.now().isoformat()
                for i, value in enumerate(values):
                    if i in self.channels:
                        self.channels[i].update(value)

                self.packet_count += 1

                return {
                    'timestamp': timestamp,
                    'channel_names': list(self.channel_names),
                    'values': values
                }

        except Exception as e:
            print(f"Process error: {e}")
            return None

    def _is_numeric(self, s: str) -> bool:
        try:
            float(s)
            return True
        except ValueError:
            return False

    def _init_channels(self):
        for i, name in enumerate(self.channel_names):
            if i < self.max_channels:
                self.channels[i] = ChannelProcessor(name, i)

    def get_waveforms(self, length: int = None) -> Dict[int, List[float]]:
        length = length or self._waveform_points
        with self.lock:
            return {i: ch.ring_buffer.get_last(length)
                    for i, ch in self.channels.items()}

    def get_all_stats(self) -> Dict[str, List[float]]:
        with self.lock:
            return {
                'min': [self.channels[i].get_stats()['min'] for i in range(len(self.channels))],
                'max': [self.channels[i].get_stats()['max'] for i in range(len(self.channels))],
                'avg': [self.channels[i].get_stats()['avg'] for i in range(len(self.channels))]
            }

    def get_latest_values(self) -> List[float]:
        with self.lock:
            return [self.channels[i].latest_value for i in range(len(self.channels))]

    def reset_all_stats(self):
        for ch in self.channels.values():
            ch.reset_stats()

    def get_channel_count(self) -> int:
        return len(self.channel_names)

    def get_channel_names(self) -> List[str]:
        return list(self.channel_names)

    def reset(self) -> None:
        """Clear channel detection state. Called on serial/BLE disconnect
        so the next reconnect gets to re-learn column width from scratch
        — avoids a truncated first packet locking in a narrow channel
        list for the rest of the process lifetime."""
        with self.lock:
            self.channels.clear()
            self.channel_names = []
            self.packet_count = 0
            print("[DataProcessor] State reset (channels cleared)")