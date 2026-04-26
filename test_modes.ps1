# test_modes.ps1 — verify that permissionMode / effort / thinking are
# plumbed end-to-end from an HTTP request to the SDK query() call.
#
# Usage:
#   cd d:\Imperial\individual\esp32_sensor_dashboard
#   powershell -ExecutionPolicy Bypass -File .\test_modes.ps1
#
# What to watch: the BACKEND console output while this script runs.
# You should see three kinds of log lines per request:
#
#   [chat] request body:        { … permissionMode: 'plan', effort: 'high', thinking: {…} }
#   [chat] spawn diag:          { … permissionMode, effort, thinking printed }
#   [chat] query options keys:  [ 'abortController', 'cwd', 'effort', 'permissionMode', 'thinking', … ]
#   [chat] → permissionMode: plan
#   [chat] → effort: high
#   [chat] → thinking: {"type":"enabled","budgetTokens":10000}
#
# If any of these are missing, you've found the failing leg.

$ErrorActionPreference = 'Stop'

$backend = 'http://127.0.0.1:3000'

# A real directory that exists — the handler statSync's the cwd before
# spawning. process.cwd() of the backend works fine too.
$cwd = (Resolve-Path 'backend/claude').Path -replace '\\', '/'

function Send-Probe {
  param(
    [string]$label,
    [hashtable]$extra
  )
  Write-Host "`n=========================================="
  Write-Host "TEST: $label" -ForegroundColor Cyan
  Write-Host "=========================================="

  $body = @{
    message          = "What is 2+2? Reply with only the number."
    requestId        = "probe-$(Get-Random)"
    workingDirectory = $cwd
  } + $extra

  $json = $body | ConvertTo-Json -Depth 6 -Compress
  Write-Host "→ Sending request body:"
  Write-Host "  $json" -ForegroundColor DarkGray

  try {
    # -TimeoutSec 60 because cold start + SDK init can be slow the
    # first time. Reading only the first ~5 lines of the NDJSON
    # stream is enough to confirm the request reached the CLI.
    $response = Invoke-WebRequest `
      -Method Post `
      -Uri "$backend/api/chat" `
      -ContentType 'application/json' `
      -Body $json `
      -UseBasicParsing `
      -TimeoutSec 60
    $lines = $response.Content -split "`n" | Where-Object { $_ } | Select-Object -First 3
    Write-Host "← First response lines:"
    foreach ($line in $lines) {
      Write-Host "  $($line.Substring(0, [Math]::Min(150, $line.Length)))" -ForegroundColor DarkGray
    }
  } catch {
    Write-Host "✗ Request failed: $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host "`n⚠  Before running: check that the backend is serving at $backend"
Write-Host "   and watch its console while this script runs."
Write-Host "   The backend log is where you verify the params arrived."

# ---------- Test 1: baseline, no optional params ----------
# Expected backend log: request body shows permissionMode=undefined,
# effort=undefined, thinking=undefined. Query options should NOT
# contain effort / thinking keys; permissionMode key is also absent
# (we only add it when present).
Send-Probe -label "Baseline (no optional fields)" -extra @{}

Start-Sleep -Seconds 2

# ---------- Test 2: permissionMode only ----------
# Expected: request body + query options both show permissionMode='plan'.
Send-Probe -label "permissionMode=plan" -extra @{
  permissionMode = 'plan'
}

Start-Sleep -Seconds 2

# ---------- Test 3: effort only ----------
# Expected: request body + query options both show effort='high'.
Send-Probe -label "effort=high" -extra @{
  effort = 'high'
}

Start-Sleep -Seconds 2

# ---------- Test 4: thinking only ----------
# Expected: request body + query options both show thinking obj.
Send-Probe -label "thinking=enabled(10000)" -extra @{
  thinking = @{ type = 'enabled'; budgetTokens = 10000 }
}

Start-Sleep -Seconds 2

# ---------- Test 5: all three together ----------
# This is the one that matters — mirrors what the frontend sends when
# the user cycles all three pills off their defaults.
Send-Probe -label "all three" -extra @{
  permissionMode = 'acceptEdits'
  effort         = 'max'
  thinking       = @{ type = 'enabled'; budgetTokens = 10000 }
}

Write-Host "`n=========================================="
Write-Host "Done. Now diff the backend logs against expectations."
Write-Host "=========================================="
