# AVU CPI WebApp Setup Guide

## Quick Setup on New Computer

### Prerequisites
- Python 3.8 or higher (preferably Python 3.11-3.13)
- Git (optional, for version control)

### Setup Steps

1. **Copy the Project**
   - Copy the entire `AVU_CPI_webapp` folder to your new computer
   - Place it anywhere accessible (e.g., Desktop, Documents, etc.)

2. **Install Python Dependencies**
   ```powershell
   # Navigate to the project folder
   cd C:\path\to\AVU_CPI_webapp
   
   # Install required packages
   pip install -r requirements.txt
   ```

3. **Update File Paths (Important!)**
   Edit `app.py` and update these paths to match your new computer:
   ```python
   # Lines ~234-235 in app.py
   IRON_DATA_PATH = Path(r"C:\Users\[YourUsername]\OneDrive - AVU SA\AVU CPI Campaign\Puzzle_control_Reports\IRON_DATA")
   SOURCE_PATH = Path(r"C:\Users\[YourUsername]\OneDrive - AVU SA\AVU CPI Campaign\Puzzle_control_Reports\SOURCE_FILES")
   
   # Line ~240 (cards JSON path)
   CARDS_JSON_PATH = Path(r"C:\Users\[YourUsername]\OneDrive - AVU SA\AVU CPI Campaign\Puzzle_control_Reports\SOURCE_FILES\all_stock_cards.json")
   ```

4. **Run the Application**
   ```powershell
   python app.py
   ```
   
   The app will be available at: http://localhost:5000
   Or from other devices on the network at: http://[YOUR-COMPUTER-IP]:5000

### Alternative: Using Virtual Environment (Recommended for Production)

For better isolation, use a virtual environment:

```powershell
# Create virtual environment
python -m venv venv

# Activate it
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the app
python app.py
```

### Troubleshooting

**If you get "Module not found" errors:**
```powershell
pip install --upgrade pip
pip install -r requirements.txt --force-reinstall
```

**If paths don't exist:**
- Make sure OneDrive is synced on the new computer
- Update the paths in `app.py` to match your new computer's file structure
- Ensure all data files are accessible

**If port 5000 is busy:**
- Change the port in the last line of `app.py`:
  ```python
  app.run(debug=Settings.DEBUG, use_reloader=False, host="0.0.0.0", port=5001)
  ```

### Files You Need to Ensure Are Present

Essential files that must be copied:
- `app.py` (main application)
- `config.py` (configuration)
- `requirements.txt` (dependencies)
- `templates/` folder (HTML templates)
- `static/` folder (CSS, JS, images)
- `utils/` folder (helper modules)
- `notebooks/` folder (Jupyter notebooks and JSON configs)

Data files (ensure these paths exist on new computer):
- OneDrive folder with IRON_DATA and SOURCE_FILES
- Especially: `all_stock_cards.json` file

### Network Access

The app is configured to accept connections from any computer on your network.
To access from other devices, use:
- http://[NEW-COMPUTER-IP]:5000

You can find your computer's IP with:
```powershell
ipconfig
```
Look for the "IPv4 Address" under your network adapter.