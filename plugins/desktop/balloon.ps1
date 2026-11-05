param([string]$Title, [string]$Body)
Add-Type -AssemblyName System.Windows.Forms
$balloon = New-Object System.Windows.Forms.NotifyIcon
$balloon.Icon = [System.Drawing.SystemIcons]::Information
$balloon.Visible = $true
$balloon.ShowBalloonTip(5000, $Title, $Body, 'Info')
Start-Sleep -Milliseconds 5000
$balloon.Dispose()
