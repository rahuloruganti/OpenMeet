# Builds py/dist/OpenMeet-py.exe (PyInstaller one-file, windowed).
# Steps: create py/.venv if missing, install pinned wheels, build the React UI into py/web, bundle
# py/web and the Rust migrations, then run PyInstaller. No Visual Studio, Windows SDK or C compiler.
# Usage (from the repo root): powershell -ExecutionPolicy Bypass -File py/build.ps1

$ErrorActionPreference = "Stop"
$py = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $py
$venv = Join-Path $py ".venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $python)) {
    py -3.13 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create $venv with Python 3.13." }
}
& $python -m pip install --only-binary=:all: --quiet -r (Join-Path $py "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed." }

Push-Location $repo
try {
    corepack pnpm exec vite build --config py/vite.py.config.ts
    if ($LASTEXITCODE -ne 0) { throw "vite build failed." }

    $web = Join-Path $py "web"
    $migrations = Join-Path $repo "src-tauri\migrations"
    & $python -m PyInstaller --noconfirm --clean --onefile --windowed `
        --name OpenMeet-py `
        --distpath (Join-Path $py "dist") `
        --workpath (Join-Path $py "build") `
        --specpath $py `
        --add-data "$web;web" `
        --add-data "$migrations;migrations" `
        --collect-submodules uvicorn `
        --hidden-import uvicorn.logging `
        --hidden-import uvicorn.loops.auto `
        --hidden-import uvicorn.protocols.http.auto `
        --hidden-import uvicorn.protocols.websockets.auto `
        --hidden-import uvicorn.lifespan.on `
        --collect-all webview `
        --collect-all pyaudiowpatch `
        --collect-all websockets `
        --hidden-import _portaudiowpatch `
        --collect-submodules win32ctypes `
        (Join-Path $py "launcher.py")
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }
} finally {
    Pop-Location
}

$exe = Join-Path $py "dist\OpenMeet-py.exe"
Write-Host "Built $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB)"
