Add-Type -AssemblyName System.Drawing

function Resize-Image {
    param (
        [string]$SourcePath,
        [string]$DestinationPath,
        [int]$Width,
        [int]$Height
    )
    if (-not (Test-Path $SourcePath)) {
        Write-Error "Source file not found: $SourcePath"
        return
    }
    
    $img = [System.Drawing.Image]::FromFile($SourcePath)
    $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    
    $g.DrawImage($img, 0, 0, $Width, $Height)
    
    $bmp.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $g.Dispose()
    $bmp.Dispose()
    $img.Dispose()
    Write-Host "Successfully resized to $Width x $Height -> $DestinationPath"
}

$baseDir = "c:\Users\MahmoudKhalidMahmoud\OneDrive - DIGINATION\Desktop\New folder\form-filler\icons"
$source = Join-Path $baseDir "master_source.png"

# Ensure icons directory exists
if (-not (Test-Path $baseDir)) {
    New-Item -ItemType Directory -Force -Path $baseDir
}

Write-Host "Checking for source file: $source"
if (Test-Path $source) {
    Resize-Image -SourcePath $source -DestinationPath (Join-Path $baseDir "icon16.png") -Width 16 -Height 16
    Resize-Image -SourcePath $source -DestinationPath (Join-Path $baseDir "icon48.png") -Width 48 -Height 48
    Resize-Image -SourcePath $source -DestinationPath (Join-Path $baseDir "icon128.png") -Width 128 -Height 128
} else {
    Write-Error "CRITICAL: master_source.png not found at $source"
}
