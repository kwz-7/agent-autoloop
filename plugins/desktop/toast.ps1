# A Windows toast, not a notification-area balloon: Windows 11 no longer shows the balloon a background program asks for,
# while a toast still shows. Called as: powershell -File toast.ps1 -Title <words> -Body <words>; both are arguments only.
param([string]$Title, [string]$Body)
$ErrorActionPreference = "Stop"

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null

# PowerShell's own app id: the shell already accepts notifications from it, and a program of ours would have to register one.
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
# Each text element is a line of the toast, so the card's lines stay apart instead of running into one paragraph.
$text = (@($Title) + @($Body -split "`r?`n") |
    Where-Object { $_ -ne "" } |
    ForEach-Object { '<text>' + [System.Security.SecurityElement]::Escape($_) + '</text>' }) -join ''

$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml('<toast><visual><binding template="ToastGeneric">' + $text + '</binding></visual></toast>')
$toast = New-Object Windows.UI.Notifications.ToastNotification $document
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
