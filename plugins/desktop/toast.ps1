# A Windows toast, not a notification-area balloon: Windows 11 no longer shows the balloon a background program asks for,
# while a toast still shows. Called as: powershell -File toast.ps1 -Title <words> -Body <words>; both are arguments only.
param([string]$Title, [string]$Body)
$ErrorActionPreference = "Stop"

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null

# PowerShell's own app id: the shell already accepts notifications from it, and a program of ours would have to register one.
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$xml = '<toast><visual><binding template="ToastGeneric"><text>{0}</text><text>{1}</text></binding></visual></toast>' -f `
  [System.Security.SecurityElement]::Escape($Title), [System.Security.SecurityElement]::Escape($Body)

$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $document
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
