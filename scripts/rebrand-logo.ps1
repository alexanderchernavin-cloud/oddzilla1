# One-shot rebrand script: take HumanDocs/Oddzilla_logo.png and emit
# every brand asset the web app + Android app reference. Re-runnable.
# Not committed to deploy — kept around so the next logo refresh is one command.

param(
    [string]$Source = "D:\AI\Oddzilla\HumanDocs\Oddzilla_logo.png",
    [string]$Root = $PSScriptRoot
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source logo not found at $Source"
}

$repoRoot = Split-Path $Root -Parent
Write-Host "Repo root: $repoRoot"
Write-Host "Source:    $Source"

$master = [System.Drawing.Image]::FromFile($Source)
Write-Host ("Master: {0}x{1}" -f $master.Width, $master.Height)

function New-PaddedSquare {
    param([System.Drawing.Image]$Src, [int]$Size, [double]$Fill = 0.92)
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $maxBox = $Size * $Fill
    $srcAspect = $Src.Width / $Src.Height
    if ($srcAspect -gt 1) {
        $w = $maxBox
        $h = $maxBox / $srcAspect
    } else {
        $h = $maxBox
        $w = $maxBox * $srcAspect
    }
    $x = ($Size - $w) / 2
    $y = ($Size - $h) / 2
    $g.DrawImage($Src, [single]$x, [single]$y, [single]$w, [single]$h)
    $g.Dispose()
    return $bmp
}

function New-Resized {
    param([System.Drawing.Image]$Src, [int]$Width, [int]$Height)
    $bmp = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($Src, 0, 0, $Width, $Height)
    $g.Dispose()
    return $bmp
}

function Save-Png {
    param([System.Drawing.Bitmap]$Bmp, [string]$Path)
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $Bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $Bmp.Dispose()
    Write-Host "  -> $Path"
}

# Aspect of new master, used by web Wordmark layout.
$aspect = [math]::Round($master.Width / $master.Height, 4)
Write-Host "Master aspect (W/H): $aspect"

# --- Web: square brand marks (favicon, sidebar Logo) -----------------
# The new mascot is wider than tall, so a "square" rendering pads it
# onto a transparent canvas. Same content for light + dark variants —
# the mascot's own colors read on both themes.
$webBrand = Join-Path $repoRoot "apps\web\public\brand"
$webApp   = Join-Path $repoRoot "apps\web\src\app"

Save-Png (New-PaddedSquare $master 512 0.92) (Join-Path $webBrand "oddzilla-light.png")
Save-Png (New-PaddedSquare $master 512 0.92) (Join-Path $webBrand "oddzilla-dark.png")
Save-Png (New-PaddedSquare $master 512 0.92) (Join-Path $webBrand "oddzilla-logo.png")

# --- Web: wordmark (landscape rendering of the new mascot) -----------
# Keep the natural aspect of the source so nothing gets stretched.
# The Wordmark component derives rendered width from this aspect.
$wmH = 800
$wmW = [int][math]::Round($wmH * $aspect)
Save-Png (New-Resized $master $wmW $wmH) (Join-Path $webBrand "wordmark-light.png")
Save-Png (New-Resized $master $wmW $wmH) (Join-Path $webBrand "wordmark-dark.png")
Save-Png (New-Resized $master $wmW $wmH) (Join-Path $webBrand "wordmark-transparent.png")

# --- Web: Next.js conventional icons (auto-picked up by metadata) ----
Save-Png (New-PaddedSquare $master 256 0.92) (Join-Path $webApp "icon.png")
Save-Png (New-PaddedSquare $master 180 0.92) (Join-Path $webApp "apple-icon.png")

# Open Graph image is 1200x630 per Twitter / Facebook spec. Center the
# logo on a transparent canvas so previews show the full mascot.
$og = New-Object System.Drawing.Bitmap 1200, 630, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ogG = [System.Drawing.Graphics]::FromImage($og)
$ogG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$ogG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$ogG.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$ogG.Clear([System.Drawing.Color]::FromArgb(255, 13, 13, 12))  # brand_ink
$boxW = 1200 * 0.78
$boxH = 630  * 0.78
# Fit source within the box keeping aspect.
$srcAsp = $master.Width / $master.Height
if ($boxW / $boxH -gt $srcAsp) {
    $h = $boxH
    $w = $boxH * $srcAsp
} else {
    $w = $boxW
    $h = $boxW / $srcAsp
}
$x = (1200 - $w) / 2
$y = (630  - $h) / 2
$ogG.DrawImage($master, [single]$x, [single]$y, [single]$w, [single]$h)
$ogG.Dispose()
Save-Png $og (Join-Path $webApp "opengraph-image.png")

# --- Android: adaptive launcher foreground + splash ------------------
# Adaptive icon canvas is 108x108dp; we render at xxxhdpi (4x) = 432px.
# The visible safe zone (any launcher mask) is the central 66dp -> 264px.
# Logo content fills ~62% of the canvas so circular / squircle masks
# never clip the mascot.
$mobileDrawable = Join-Path $repoRoot "apps\mobile-android\app\src\main\res\drawable"
Save-Png (New-PaddedSquare $master 432 0.62) (Join-Path $mobileDrawable "ic_launcher_foreground.png")

# Splash screen icon. SplashScreen API renders at 288dp on a 240dp
# visible disc; allowing a bit of slack in the fill so the round mask
# doesn't bite the mascot's spikes.
Save-Png (New-PaddedSquare $master 432 0.58) (Join-Path $mobileDrawable "ic_splash_logo.png")

$master.Dispose()
Write-Host ""
Write-Host "Done. Aspect for monogram.tsx: $aspect"
