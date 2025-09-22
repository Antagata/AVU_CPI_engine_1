@echo off
echo Setting up AVU CPI WebApp...
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.8+ from https://python.org
    pause
    exit /b 1
)

echo Python found. Installing dependencies...
pip install -r requirements.txt

if errorlevel 1 (
    echo.
    echo ERROR: Failed to install dependencies
    echo Try running: pip install --upgrade pip
    echo Then run this script again
    pause
    exit /b 1
)

echo.
echo Setup complete!
echo.
echo IMPORTANT: Before running the app, please:
echo 1. Update the file paths in app.py to match this computer
echo 2. Ensure OneDrive is synced with your data files
echo.
echo To start the app, run: python app.py
echo.
pause