# config.py
from pathlib import Path
import os

class Settings:
    # Flask
    DEBUG = os.getenv("FLASK_DEBUG", "0") == "1"
    SECRET_KEY = os.getenv("SECRET_KEY", "change-me")
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", 512 * 1024))  # 512KB JSON posts

    # Default OneDrive base
    _BASE = Path.home() / "OneDrive - AVU SA" / "AVU CPI Campaign" / "Puzzle_control_Reports"

    # Paths from env with OneDrive fallback
    AVU_SOURCE_PATH = Path(os.getenv("AVU_SOURCE_PATH", str(_BASE / "SOURCE_FILES")))
    AVU_OUTPUT_PATH = Path(os.getenv("AVU_OUTPUT_PATH", str(_BASE / "IRON_DATA")))

    # Expose with the names the app expects
    SOURCE_PATH = AVU_SOURCE_PATH
    IRON_DATA_PATH = AVU_OUTPUT_PATH

    @staticmethod
    def missing_path_messages():
        msgs = []
        if not Settings.SOURCE_PATH.exists():
            msgs.append(f"SOURCE path not found: {Settings.SOURCE_PATH}")
        if not Settings.IRON_DATA_PATH.exists():
            msgs.append(f"OUTPUT path not found: {Settings.IRON_DATA_PATH}")
        return msgs
