# Builds packaging/dist/OpenMeet.exe (PyInstaller one-file, windowed).
# Steps: sync the uv environment, build the React UI into backend/web, bundle the UI and the SQL
# migrations into the exe, then run PyInstaller. No Visual Studio, Windows SDK or C compiler.
# Usage (works from any cwd): powershell -ExecutionPolicy Bypass -File packaging/build.ps1

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$packaging = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $packaging
$backend = Join-Path $repo "backend"
$web = Join-Path $backend "web"
$migrations = Join-Path $backend "openmeet_py\migrations"
$catalog = Join-Path $backend "openmeet_py\local_ai\catalog.json"
$launcher = Join-Path $backend "launcher.py"
$dist = Join-Path $packaging "dist"
$work = Join-Path $packaging "build"
$exe = Join-Path $dist "OpenMeet.exe"
# App icon (exe, taskbar and window). Rendered from openmeet-icon.svg at 16-256 px.
$icon = Join-Path $packaging "openmeet.ico"

function Assert-Exit {
    param([string]$Label)
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)." }
}

foreach ($required in @($launcher, $migrations, $catalog, $icon, (Join-Path $repo "package.json"))) {
    if (-not (Test-Path $required)) { throw "Missing $required." }
}

Push-Location $repo
try {
    # 1. Python environment, exactly as locked.
    uv sync --project backend --locked
    Assert-Exit "uv sync"

    # 2. React UI -> backend/web. PyInstaller resolves --add-data sources relative to the cwd,
    #    so every path below is absolute and built from the repo root.
    if (-not (Test-Path (Join-Path $repo "node_modules"))) {
        corepack pnpm install --frozen-lockfile
        Assert-Exit "pnpm install"
    }
    corepack pnpm exec vite build
    Assert-Exit "vite build"
    if (-not (Test-Path (Join-Path $web "index.html"))) { throw "vite build did not produce $web\index.html." }

    # 3. One-file windowed exe.
    New-Item -ItemType Directory -Force -Path $packaging | Out-Null
    uv run --project backend pyinstaller --noconfirm --clean --onefile --windowed `
        --name OpenMeet `
        --icon $icon `
        --distpath $dist `
        --workpath $work `
        --specpath $packaging `
        --paths $backend `
        --add-data "$web;web" `
        --add-data "$migrations;openmeet_py/migrations" `
        --add-data "$catalog;openmeet_py/local_ai" `
        --collect-submodules openmeet_py `
        --collect-submodules uvicorn `
        --hidden-import uvicorn.logging `
        --hidden-import uvicorn.loops.auto `
        --hidden-import uvicorn.protocols.http.auto `
        --hidden-import uvicorn.protocols.websockets.auto `
        --hidden-import uvicorn.lifespan.on `
        --collect-all webview `
        --collect-all pyaudiowpatch `
        --collect-all websockets `
        --collect-all pywhispercpp `
        --collect-binaries pywhispercpp `
        --hidden-import pywhispercpp.model `
        --hidden-import pywhispercpp.constants `
        --hidden-import pywhispercpp.utils `
        --hidden-import _pywhispercpp `
        --hidden-import _portaudiowpatch `
        --collect-all sherpa_onnx `
        --collect-binaries sherpa_onnx `
        --hidden-import sherpa_onnx.lib._sherpa_onnx `
        --collect-submodules win32ctypes `
        $launcher
    Assert-Exit "PyInstaller"
} finally {
    Pop-Location
}

if (-not (Test-Path $exe)) { throw "PyInstaller did not produce $exe." }
$file = Get-Item $exe
$hash = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLowerInvariant()
$sizeMb = [math]::Round($file.Length / 1MB, 1)
Write-Host ""
Write-Host "Built  $exe"
Write-Host "Size   $($file.Length) bytes ($sizeMb MB)"
Write-Host "SHA256 $hash"
