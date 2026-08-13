# 全屏截图(捕获 XStudio 若已弹出)
$ErrorActionPreference = "SilentlyContinue"
Start-Process "C:\Program Files\NetEase Cloud Music XStudio\NetEase Cloud Music XStudio.exe"
Start-Sleep 25

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("C:\Users\Admin\OneDrive\Desktop\HUMIX\tools\xstudio_shot.png")
Write-Output ("FULLSCREEN SHOT: " + $bounds.Width + "x" + $bounds.Height)
