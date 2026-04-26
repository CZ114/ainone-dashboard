"""
Pydantic models for API requests and responses
"""
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime


class SerialConnectRequest(BaseModel):
    port: str
    baud_rate: int = 115200


class SerialStatus(BaseModel):
    connected: bool
    port: Optional[str] = None
    baud_rate: Optional[int] = None


class BLEScanResult(BaseModel):
    name: str
    address: str


class AudioStartRequest(BaseModel):
    port: int = 8888


class AudioStatus(BaseModel):
    connected: bool
    port: Optional[int] = None
    rms_db: float = -100.0
    peak_db: float = -100.0


class RecordingStartRequest(BaseModel):
    duration_seconds: int = 60
    include_audio: bool = True


class RecordingStatus(BaseModel):
    is_recording: bool
    elapsed_seconds: float = 0.0
    remaining_seconds: float = 0.0
    csv_path: Optional[str] = None
    audio_path: Optional[str] = None


class DisplaySettings(BaseModel):
    points_per_channel: int = 100
    cards_per_row: int = 4


class ChannelInfo(BaseModel):
    index: int
    name: str
    enabled: bool
    color: str


class ConnectionStatus(BaseModel):
    serial: SerialStatus
    ble: SerialStatus  # Reuse SerialStatus for BLE
    audio: AudioStatus


# WebSocket message models
class SensorDataMessage(BaseModel):
    type: str = "sensor_data"
    timestamp: str
    channels: List[str]
    values: List[float]
    waveforms: List[List[float]]
    stats: Dict[str, List[float]]


class AudioLevelMessage(BaseModel):
    type: str = "audio_level"
    rms_db: float
    peak_db: float
    is_recording: bool


class ChannelConfigMessage(BaseModel):
    type: str = "channel_config"
    channels: List[ChannelInfo]