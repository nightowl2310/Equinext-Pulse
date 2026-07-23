@echo off
REM ===================================================================
REM  Equinext Pulse - the daily job.
REM
REM  Windows Task Scheduler runs this every day at 19:00 (7 PM IST).
REM  7 PM, not 4 PM: NSE only publishes a day's participant-OI file
REM  after ~6 PM IST, so an afternoon run would 404 every single day.
REM
REM  One command does the whole chain:
REM     download CSV -> load into nse_data.db -> print brief
REM                  -> refresh frontend/public/data/*.json
REM
REM  Everything is appended to logs\daily.log, so a night that fails
REM  leaves evidence instead of vanishing silently.
REM ===================================================================

REM Always work from the project folder. Task Scheduler would otherwise
REM start us in C:\Windows\System32, and the relative paths for
REM nse_oi_data\ and nse_data.db would be created THERE instead of here.
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

echo.>> "logs\daily.log"
echo ======== %DATE% %TIME% ========>> "logs\daily.log"

REM Use the project's own virtual environment, not whatever "python"
REM happens to be on PATH when the task fires.
".venv\Scripts\python.exe" nse_oi_scraper.py >> "logs\daily.log" 2>&1
set RC=%ERRORLEVEL%

echo ---- finished, exit code %RC% ---->> "logs\daily.log"
exit /b %RC%
