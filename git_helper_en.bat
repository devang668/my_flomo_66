@echo off
setlocal enabledelayedexpansion

:: Show loading prompt to confirm script is running
echo Searching for Git repository... (max 10 parent directories)
echo.

:: Auto-detect Git project root (with depth limit)
call :FindGitRoot "%~dp0"

:: Clear loading screen and show main menu
cls
goto MainMenu

:MainMenu
echo.
echo ================= Git Quick Operations Menu =================
if defined GIT_ROOT (
    echo Current Git Project Path: !GIT_ROOT!
) else (
    echo No active Git project path set.
)
echo.
echo 1. git pull
echo 2. git add .
echo 3. git commit (enter commit message)
echo 4. git push
echo 5. git status
echo 6. Set custom project path (manual input)
echo 7. Clear current project path
echo 8. Exit
echo.
set /p choice=Enter your selection (1-8): 

if "%choice%"=="1" goto GitPull
if "%choice%"=="2" goto GitAdd
if "%choice%"=="3" goto GitCommit
if "%choice%"=="4" goto GitPush
if "%choice%"=="5" goto GitStatus
if "%choice%"=="6" goto SetCustomPath
if "%choice%"=="7" goto ClearPath
if "%choice%"=="8" goto ExitScript

echo Invalid option. Please try again.
timeout /t 2 /nobreak >nul
goto MainMenu

:GitPull
if not defined GIT_ROOT (
    echo Error: No active Git project path set. Use option 6 to specify one.
    pause
    goto MainMenu
)
cd /d "!GIT_ROOT!"
echo.
echo Executing: git pull (in !GIT_ROOT!)
git pull
echo.
pause
goto MainMenu

:GitAdd
if not defined GIT_ROOT (
    echo Error: No active Git project path set. Use option 6 to specify one.
    pause
    goto MainMenu
)
cd /d "!GIT_ROOT!"
echo.
echo Executing: git add . (in !GIT_ROOT!)
git add .
echo.
pause
goto MainMenu

:GitCommit
if not defined GIT_ROOT (
    echo Error: No active Git project path set. Use option 6 to specify one.
    pause
    goto MainMenu
)
cd /d "!GIT_ROOT!"
echo.
set /p commit_msg=Enter commit message: 
if "!commit_msg!"=="" (
    echo Error: Commit message cannot be empty.
    pause
    goto MainMenu
)
echo Executing: git commit -m "!commit_msg!" (in !GIT_ROOT!)
git commit -m "!commit_msg!"
echo.
pause
goto MainMenu

:GitPush
if not defined GIT_ROOT (
    echo Error: No active Git project path set. Use option 6 to specify one.
    pause
    goto MainMenu
)
cd /d "!GIT_ROOT!"
echo.
echo Executing: git push (in !GIT_ROOT!)
git push
echo.
pause
goto MainMenu

:GitStatus
if not defined GIT_ROOT (
    echo Error: No active Git project path set. Use option 6 to specify one.
    pause
    goto MainMenu
)
cd /d "!GIT_ROOT!"
echo.
echo Executing: git status (in !GIT_ROOT!)
git status
echo.
pause
goto MainMenu

:SetCustomPath
echo.
set /p custom_path=Enter full Git project path (e.g., D:\Projects\MyRepo): 
:: Trim trailing backslash if exists
if "!custom_path:~-1!"=="\" set "custom_path=!custom_path:~0,-1!"
:: Verify path exists and contains .git folder
if not exist "!custom_path!" (
    echo Error: Path "!custom_path!" does not exist.
    pause
    goto MainMenu
)
if not exist "!custom_path!\.git" (
    echo Error: Path "!custom_path!" is not a Git repository (no .git folder found).
    pause
    goto MainMenu
)
:: Set as active project path
set "GIT_ROOT=!custom_path!"
echo Success: Active Git project path updated to: !GIT_ROOT!
pause
goto MainMenu

:ClearPath
if not defined GIT_ROOT (
    echo Info: No active Git project path to clear.
    pause
    goto MainMenu
)
set "GIT_ROOT="
echo Success: Current Git project path has been cleared.
pause
goto MainMenu

:ExitScript
echo.
echo Script exited successfully.
exit /b

:: Fixed Function: Find Git root with depth limit (prevents infinite loops)
:FindGitRoot
set "dir=%~1"
set "max_depth=10"  :: Limit search to 10 parent folders (adjust if needed)
set "current_depth=0"

:FindLoop
:: Stop if max depth is reached
if !current_depth! gtr !max_depth! (
    set "GIT_ROOT="
    exit /b
)

:: Check for .git folder
if exist "%dir%\.git" (
    set "GIT_ROOT=%dir%"
    :: Sanitize path (remove trailing backslash)
    if "!GIT_ROOT:~-1!"=="\" set "GIT_ROOT=!GIT_ROOT:~0,-1!"
    exit /b
)

:: Stop at drive root (e.g., C:\)
if "%dir:~1%"==":\" (
    set "GIT_ROOT="
    exit /b
)

:: Move to parent directory
for %%F in ("%dir%") do set "dir=%%~dpF"
set "dir=!dir:~0,-1!"  :: Remove trailing backslash
set /a current_depth+=1  :: Increment depth counter
goto FindLoop