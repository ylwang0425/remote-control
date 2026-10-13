$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\src\workbuddy-native'
Add-Type -Path @('windows-uia-com.cs','windows-uia-pending.cs','model-popup.cs','pending-actions.cs','native-input.cs' | ForEach-Object { Join-Path $root $_ })
$method = [WorkBuddyWindowsUiaComProbe].GetMethod('BuildComposerInput', [Reflection.BindingFlags]'NonPublic,Static')
$text = [string][char]0x4e2d + [char]0x6587 + "`nA"
$events = $method.Invoke($null, @($text, $false))
if ($events.Count -ne 10) { throw 'wrong unicode and newline event count' }
$returns = @($events | Where-Object { $_.input.keyboard.key -eq 13 })
if ($returns.Count -ne 2 -or $events[4].input.keyboard.key -ne 16 -or $events[7].input.keyboard.key -ne 16) { throw 'newline must use Shift+Enter' }
if ($events[0].input.keyboard.scan -ne 0x4e2d -or $events[0].input.keyboard.flags -ne 4 -or $events[1].input.keyboard.flags -ne 6) { throw 'unicode input invalid' }
$replacement = $method.Invoke($null, @('A', $true))
if ($replacement.Count -ne 6 -or $replacement[0].input.keyboard.key -ne 17 -or $replacement[3].input.keyboard.flags -ne 2) { throw 'known draft selection invalid' }
if ($method.Invoke($null, @("A`0B", $false)).Count -ne 0) { throw 'control injection accepted' }
$inputType = [WorkBuddyWindowsUiaComProbe].GetNestedType('ComposerInput', [Reflection.BindingFlags]'NonPublic')
$inputValue = [Activator]::CreateInstance($inputType)
if ([Runtime.InteropServices.Marshal]::SizeOf($inputValue) -ne $(if ([IntPtr]::Size -eq 8) { 40 } else { 28 })) { throw 'incorrect INPUT ABI size' }
'native text input fixture passed'
