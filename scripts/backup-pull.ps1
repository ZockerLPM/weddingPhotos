<#
.SYNOPSIS
  Backup der Fotowand-Daten direkt unter Windows – ohne WSL und ohne rsync.

.DESCRIPTION
  Braucht nur den in Windows 11 enthaltenen OpenSSH-Client (ssh, scp) und
  tar.exe. Kopiert inkrementell: Fotodateien haben eindeutige, unveraenderliche
  Namen, deshalb wird nur geholt, was lokal noch fehlt.

  Alle Dateien kommen ueber EINE SSH-Verbindung als tar-Datenstrom. Das ist
  nicht nur schneller als viele Einzelaufrufe, sondern fragt vor allem die
  Passphrase hoechstens zweimal statt einmal pro Block.

  Damit gar keine Passphrase mehr noetig ist, den Schluessel einmalig in den
  ssh-agent legen – das Skript weist darauf hin, wenn er fehlt.

.EXAMPLE
  .\backup-pull.ps1 -Server deploy@203.0.113.10 -Dest C:\Users\ppppp\hochzeitBackup
#>
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Dest = "$env:USERPROFILE\hochzeitBackup",
  [string]$SshKey = "$env:USERPROFILE\.ssh\hochzeit",
  [string]$RemoteDir = '/opt/hochzeit/app'
)

$ErrorActionPreference = 'Stop'
$photoDir = Join-Path $Dest 'photos'
New-Item -ItemType Directory -Force -Path $photoDir | Out-Null

$useKey = Test-Path $SshKey
$sshArgs = @()
if ($useKey) { $sshArgs = @('-i', $SshKey) }

function Invoke-Remote([string]$Command) {
  & ssh @sshArgs -o BatchMode=no $Server $Command
}

# --- 0. Passphrase-Abfragen vermeiden ---------------------------------------
# Ohne geladenen Schluessel fragt JEDER ssh-Aufruf nach der Passphrase.
$agentHint = $false
try {
  $null = & ssh-add -l 2>&1
  if ($LASTEXITCODE -ne 0) { $agentHint = $true }
} catch { $agentHint = $true }

if ($agentHint) {
  Write-Host ''
  Write-Host 'Hinweis: Der Schluessel liegt nicht im ssh-agent.' -ForegroundColor Yellow
  Write-Host 'Einmalig einrichten (PowerShell als Administrator):' -ForegroundColor Yellow
  Write-Host '    Set-Service ssh-agent -StartupType Automatic'
  Write-Host '    Start-Service ssh-agent'
  Write-Host 'Danach einmal pro Rechner (normale PowerShell):'
  Write-Host "    ssh-add `"$SshKey`""
  Write-Host 'Ab dann fragt kein Backup mehr nach der Passphrase.'
  Write-Host ''
}

# --- 1. Konsistenten Datenbank-Schnappschuss erzeugen ------------------------
# Der Server schreibt im WAL-Modus; ein direktes Kopieren der laufenden
# Datenbank kann einen halben Schreibvorgang erwischen. VACUUM INTO erzeugt
# eine in sich stimmige Kopie, ohne den Betrieb zu stoeren.
$snippet = @'
const D = require('better-sqlite3');
const fs = require('fs');
try { fs.unlinkSync('/data/app-snapshot.db'); } catch (e) {}
const db = new D('/data/app.db', { readonly: true });
db.exec("VACUUM INTO '/data/app-snapshot.db'");
db.close();
console.log('ok');
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($snippet))

Write-Host '-> Datenbank-Schnappschuss auf dem Server ...'
$snapCmd = "cd '$RemoteDir' && docker compose exec -T app node -e " +
           "`"eval(Buffer.from('$b64','base64').toString())`""
Invoke-Remote $snapCmd | Out-Null
$snapshotOk = ($LASTEXITCODE -eq 0)
if (-not $snapshotOk) {
  Write-Warning 'Schnappschuss nicht moeglich - es wird die Live-Datenbank kopiert.'
}

# --- 2. Fehlende Dateien bestimmen ------------------------------------------
Write-Host '-> Dateiliste vom Server ...'
$remote = @(Invoke-Remote "ls -1 '$RemoteDir/data/photos' 2>/dev/null" |
  Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })

$local = @{}
Get-ChildItem -Path $photoDir -File -ErrorAction SilentlyContinue |
  ForEach-Object { $local[$_.Name] = $true }

$missing = @($remote | Where-Object { -not $local.ContainsKey($_) })
Write-Host "   $($remote.Count) auf dem Server, $($missing.Count) fehlen lokal."

# --- 3. Alles in EINER Verbindung holen -------------------------------------
# tar-Datenstrom durch die SSH-Verbindung. Die Pipe laeuft ueber cmd.exe,
# weil PowerShell-Pipelines Binaerdaten als Text behandeln und dabei
# zerstoeren wuerden.
function Copy-ViaTar([string[]]$Names) {
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tarExe)) { return $false }

  # Dateiliste fuer das entfernte tar -T - ; Zeilenenden muessen LF sein.
  $listFile = [IO.Path]::GetTempFileName()
  $text = ($Names -join "`n") + "`n"
  [IO.File]::WriteAllText($listFile, $text, (New-Object Text.UTF8Encoding($false)))

  $keyPart = if ($useKey) { "-i `"$SshKey`"" } else { '' }
  $remoteCmd = "tar -cf - -C '$RemoteDir/data/photos' -T -"
  $line = "ssh $keyPart $Server `"$remoteCmd`" < `"$listFile`" | " +
          "`"$tarExe`" -xf - -C `"$photoDir`""

  cmd /c $line
  $ok = ($LASTEXITCODE -eq 0)
  Remove-Item $listFile -Force -ErrorAction SilentlyContinue
  return $ok
}

# Rueckfallebene, falls tar nicht verfuegbar ist oder der Strom abbricht.
function Copy-ViaScp([string[]]$Names) {
  $batch = 40
  $failed = @()
  for ($i = 0; $i -lt $Names.Count; $i += $batch) {
    $slice = $Names[$i..([Math]::Min($i + $batch - 1, $Names.Count - 1))]
    $paths = ($slice | ForEach-Object { "$RemoteDir/data/photos/$_" }) -join ' '
    Write-Host ("   {0}/{1} ..." -f [Math]::Min($i + $batch, $Names.Count), $Names.Count)
    & scp @sshArgs -q "${Server}:`"$paths`"" $photoDir
    if ($LASTEXITCODE -ne 0) { $failed += $slice }
  }
  return $failed
}

if ($missing.Count -gt 0) {
  Write-Host '-> Dateien holen (eine Verbindung) ...'
  if (-not (Copy-ViaTar $missing)) {
    Write-Warning 'tar-Uebertragung fehlgeschlagen - es wird einzeln kopiert.'
    $rest = Copy-ViaScp $missing
    if ($rest.Count -gt 0) {
      Write-Host "   Zweiter Versuch fuer $($rest.Count) Dateien ..."
      $rest = Copy-ViaScp $rest
      if ($rest.Count -gt 0) {
        Write-Warning "$($rest.Count) Dateien fehlen weiterhin - Skript nochmal laufen lassen."
      }
    }
  }
}

# --- 4. Datenbank holen ------------------------------------------------------
Write-Host '-> Datenbank ...'
$dbRemote = if ($snapshotOk) { 'app-snapshot.db' } else { 'app.db' }
& scp @sshArgs -q "${Server}:$RemoteDir/data/$dbRemote" (Join-Path $Dest 'app.db')

# --- 5. Ergebnis pruefen -----------------------------------------------------
$haveNow = @{}
Get-ChildItem -Path $photoDir -File -ErrorAction SilentlyContinue |
  ForEach-Object { $haveNow[$_.Name] = $true }
$stillMissing = @($remote | Where-Object { -not $haveNow.ContainsKey($_) })

$count = $haveNow.Count
$size = (Get-ChildItem -Path $Dest -Recurse -File -ErrorAction SilentlyContinue |
         Measure-Object -Property Length -Sum).Sum

Write-Host ''
if ($stillMissing.Count -eq 0) {
  Write-Host "Backup vollstaendig: $Dest" -ForegroundColor Green
} else {
  Write-Warning "$($stillMissing.Count) von $($remote.Count) Dateien fehlen noch."
  Write-Host 'Skript einfach nochmal laufen lassen - es holt nur das Fehlende.'
}
Write-Host ("  {0} Dateien, {1:N2} GB" -f $count, ($size / 1GB))
