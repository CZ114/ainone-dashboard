"""
Configuration settings for AinOne Dashboard Backend
"""
from pathlib import Path

# Base directory
BASE_DIR = Path(__file__).resolve().parent.parent.parent
RECORDINGS_DIR = BASE_DIR / "recordings"
CSV_DIR = RECORDINGS_DIR / "csv"
AUDIO_DIR = RECORDINGS_DIR / "audio"

# Ensure directories exist
CSV_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Serial settings
DEFAULT_BAUD_RATE = 115200
SERIAL_TIMEOUT = 1.0

# BLE settings
BLE_DEVICE_NAME = "ESP32-S3-MultiSensor"
BLE_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
BLE_CHAR_TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

# Audio settings
AUDIO_DEFAULT_PORT = 8888
AUDIO_SAMPLE_RATE = 16000

# Data processing
DEFAULT_WAVEFORM_POINTS = 100
MAX_CHANNELS = 16

# WebSocket
WS_HEARTBEAT_INTERVAL = 30