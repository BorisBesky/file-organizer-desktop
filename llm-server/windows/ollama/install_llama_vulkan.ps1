# Vulkan-enabled llama-cpp-python installation script
# This script checks prerequisites and installs llama-cpp-python with AMD GPU (Vulkan) support

Write-Host ""
Write-Host "========================================"
Write-Host "Vulkan Prerequisites Check"
Write-Host "========================================"
Write-Host ""

$allChecksPassed = $true

# Check 1: Vulkan SDK Environment Variable
Write-Host "[1/5] Checking VULKAN_SDK environment variable..." -ForegroundColor Yellow
if ($env:VULKAN_SDK) {
    Write-Host "  [OK] VULKAN_SDK found: $env:VULKAN_SDK" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] VULKAN_SDK not set" -ForegroundColor Red
    Write-Host "    Please install Vulkan SDK from: https://vulkan.lunarg.com/sdk/home#windows" -ForegroundColor Red
    $allChecksPassed = $false
}

# Check 2: glslc (Vulkan shader compiler)
Write-Host ""
Write-Host "[2/5] Checking for glslc (Vulkan shader compiler)..." -ForegroundColor Yellow
$glslc = Get-Command glslc -ErrorAction SilentlyContinue
if ($glslc) {
    Write-Host "  [OK] glslc found: $($glslc.Source)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] glslc not found" -ForegroundColor Red
    Write-Host "    This is included in the Vulkan SDK" -ForegroundColor Red
    $allChecksPassed = $false
}

# Check 3: vulkaninfo (Runtime check)
Write-Host ""
Write-Host "[3/5] Checking for vulkaninfo..." -ForegroundColor Yellow
$vulkaninfo = Get-Command vulkaninfo -ErrorAction SilentlyContinue
if ($vulkaninfo) {
    Write-Host "  [OK] vulkaninfo found: $($vulkaninfo.Source)" -ForegroundColor Green
    
    # Try to get GPU info
    Write-Host "  Running vulkaninfo to detect AMD GPU..." -ForegroundColor Yellow
    $vulkanOutput = & vulkaninfo --summary 2>&1 | Out-String
    if ($vulkanOutput -match "AMD|Radeon") {
        Write-Host "  [OK] AMD GPU detected via Vulkan!" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] No AMD GPU detected in Vulkan output" -ForegroundColor Yellow
        Write-Host "    This may still work if you have an AMD GPU with updated drivers" -ForegroundColor Yellow
    }
} else {
    Write-Host "  [FAIL] vulkaninfo not found" -ForegroundColor Red
    $allChecksPassed = $false
}

# Check 4: CMake (needed for building)
Write-Host ""
Write-Host "[4/5] Checking for CMake..." -ForegroundColor Yellow
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if ($cmake) {
    $cmakeVersion = & cmake --version 2>&1 | Select-String -Pattern "version\s+([\d\.]+)" | ForEach-Object { $_.Matches.Groups[1].Value }
    Write-Host "  [OK] CMake found: version $cmakeVersion" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] CMake not found" -ForegroundColor Red
    Write-Host "    CMake is required to build llama-cpp-python from source" -ForegroundColor Red
    Write-Host "    Install from: https://cmake.org/download/" -ForegroundColor Red
    $allChecksPassed = $false
}

# Check 5: Virtual Environment
Write-Host ""
Write-Host "[5/5] Checking Python virtual environment..." -ForegroundColor Yellow
# Try to find venv relative to script location (go up 3 levels to project root)
$projectRoot = "..\..\.."
$venvPath = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (Test-Path $venvPath) {
    $pythonVersion = & $venvPath --version 2>&1
    Write-Host "  [OK] Virtual environment found: $pythonVersion" -ForegroundColor Green
} elseif (Test-Path ".venv\Scripts\python.exe") {
    $pythonVersion = & .\.venv\Scripts\python.exe --version 2>&1
    Write-Host "  [OK] Virtual environment found: $pythonVersion" -ForegroundColor Green
    $venvPath = ".venv\Scripts\python.exe"
} else {
    Write-Host "  [FAIL] Virtual environment not found" -ForegroundColor Red
    Write-Host "    Tried: $venvPath" -ForegroundColor Red
    $allChecksPassed = $false
}

# Summary
Write-Host ""
Write-Host "========================================"
Write-Host "Prerequisites Summary"
Write-Host "========================================"
Write-Host ""

if ($allChecksPassed) {
    Write-Host "[SUCCESS] All prerequisites met!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Proceeding with llama-cpp-python installation..." -ForegroundColor Green
    Write-Host ""
    
    # Determine pip path (use same project root as python path)
    $pipPath = Join-Path $projectRoot ".venv\Scripts\pip.exe"
    if (-not (Test-Path $pipPath)) {
        $pipPath = ".venv\Scripts\pip.exe"
    }
    
    # Uninstall existing version
    Write-Host "Uninstalling existing llama-cpp-python..." -ForegroundColor Yellow
    & $pipPath uninstall llama-cpp-python -y
    
    # Set CMake args for Vulkan
    $env:CMAKE_ARGS = "-DGGML_VULKAN=ON"
    Write-Host ""
    Write-Host "CMake arguments set: $env:CMAKE_ARGS" -ForegroundColor Cyan
    
    # Install with Vulkan support
    Write-Host ""
    Write-Host "Installing llama-cpp-python with Vulkan support..." -ForegroundColor Yellow
    Write-Host "This may take several minutes to compile..." -ForegroundColor Yellow
    Write-Host ""
    
    & $pipPath install llama-cpp-python --no-cache-dir --force-reinstall --upgrade
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "[SUCCESS] Installation completed successfully!" -ForegroundColor Green
        
        # Verify Vulkan support
        Write-Host ""
        Write-Host "Verifying Vulkan support..." -ForegroundColor Yellow
        $pythonCmd = "import llama_cpp; print('GPU offload supported:', llama_cpp.llama_cpp.llama_supports_gpu_offload()); print('System info:'); print(llama_cpp.llama_cpp.llama_print_system_info().decode('utf-8'))"
        $verification = & $venvPath -c $pythonCmd 2>&1
        Write-Host $verification
        
        if ($verification -match "VULKAN" -or $verification -match "GPU offload supported: True") {
            Write-Host ""
            Write-Host "[SUCCESS] Vulkan support is enabled!" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "[WARNING] Installation succeeded but Vulkan support may not be active" -ForegroundColor Yellow
            Write-Host "Check the system info above for VULKAN in the backend list" -ForegroundColor Yellow
        }
    } else {
        Write-Host ""
        Write-Host "[FAIL] Installation failed!" -ForegroundColor Red
        Write-Host "Check the error messages above for details." -ForegroundColor Red
        exit 1
    }
    
} else {
    Write-Host "[FAIL] Some prerequisites are missing!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install the missing components:" -ForegroundColor Yellow
    Write-Host ""
    
    if (-not $env:VULKAN_SDK -or -not $glslc) {
        Write-Host "1. Install Vulkan SDK:" -ForegroundColor Yellow
        Write-Host "   https://vulkan.lunarg.com/sdk/home#windows" -ForegroundColor White
        Write-Host "2. After installation, RESTART PowerShell/Terminal" -ForegroundColor Yellow
        Write-Host "3. Run this script again" -ForegroundColor Yellow
        Write-Host ""
    }
    
    if (-not $cmake) {
        Write-Host "* Install CMake:" -ForegroundColor Yellow
        Write-Host "  https://cmake.org/download/" -ForegroundColor White
        Write-Host ""
    }
    
    Write-Host "Then run this script again: .\install_llama_vulkan.ps1" -ForegroundColor Cyan
    exit 1
}

Write-Host ""
Write-Host "========================================"
Write-Host "Installation Complete!"
Write-Host "========================================"
Write-Host ""

