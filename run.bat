@echo off
setlocal

echo ==============================================
echo  Danbooru Tag Explorer
echo ==============================================
echo.

:: Create data directory if missing
if not exist data mkdir data

:: Check for required tag_tree.json
if not exist "data\tag_tree.json" (
    echo [ERROR] data\tag_tree.json not found.
    echo         This file is bundled with the project.
    echo         To regenerate manually:
    echo           python tools\build_tag_tree.py --out data\tag_tree.json
    pause
    exit /b 1
)

:: Download danbooru.csv if missing
set "DANBOORU_CSV_URL=https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv"

if not exist "data\danbooru.csv" (
    echo Downloading danbooru.csv...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%DANBOORU_CSV_URL%' -OutFile 'data\danbooru.csv'"
    if errorlevel 1 (
        echo [ERROR] Failed to download danbooru.csv.
        echo         Please check your network connection.
        pause
        exit /b 1
    )
    echo danbooru.csv downloaded.
    echo.
)

:: Generate ja.csv if missing
if not exist "data\ja.csv" (
    if exist "generate_ja.py" (
        echo Generating ja.csv...
        python generate_ja.py 2>nul || uv run generate_ja.py 2>nul
        if errorlevel 1 (
            echo [WARN] Failed to generate ja.csv. Continuing without translations.
        )
    )
)

:: Check if port 8000 is already in use
netstat -an 2>nul | findstr ":8000 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [WARN] Port 8000 is already in use.
    echo        Please close the other application and try again.
    pause
    exit /b 1
)

:: Launch server: prefer uv, fall back to python + pip
echo Starting server...
echo Press Ctrl+C or close this window to stop.
echo.

uv --version >nul 2>&1
if not errorlevel 1 (
    uv run server.py
) else (
    echo [INFO] uv not found. Falling back to pip.
    echo        Install uv for automatic dependency management:
    echo        https://docs.astral.sh/uv/getting-started/installation/
    echo.

    python --version >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Python not found.
        echo         Install from https://www.python.org/
        echo         Make sure to check "Add Python to PATH" during install.
        pause
        exit /b 1
    )

    python -c "import flask" >nul 2>&1
    if errorlevel 1 (
        echo Installing Flask...
        python -m pip install flask --user --quiet
        if errorlevel 1 (
            echo [ERROR] Failed to install Flask.
            echo         Please run manually: pip install flask
            pause
            exit /b 1
        )
        echo Flask installed.
        echo.
    )

    python server.py
)
