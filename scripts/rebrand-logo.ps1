# One-shot rebrand script: take HumanDocs/Oddzilla_logo.png and emit
# every brand asset the web app + Android app reference. Re-runnable.
# Tight-crops the master to its non-transparent bounding box before
# resizing so square targets (favicon / Apple touch icon / Android
# launcher) get the maximum visible content for their canvas instead
# of inheriting whatever transparent padding the source happened to
# ship with.

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

# --- Helpers --------------------------------------------------------

function Get-ContentBox {
    # Find the bounding box of non-transparent pixels using LockBits
    # (raw byte access — GetPixel on a 4M-pixel image is unusably slow).
    param([System.Drawing.Bitmap]$Bmp, [int]$AlphaThreshold = 8)
    $w = $Bmp.Width
    $h = $Bmp.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $bytes = New-Object byte[] ($stride * $h)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        $minX = $w
        $minY = $h
        $maxX = -1
        $maxY = -1
        for ($y = 0; $y -lt $h; $y++) {
            $rowStart = $y * $stride
            for ($x = 0; $x -lt $w; $x++) {
                # 32bppArgb is little-endian BGRA; alpha is the 4th byte.
                $alpha = $bytes[$rowStart + ($x * 4) + 3]
                if ($alpha -gt $AlphaThreshold) {
                    if ($x -lt $minX) { $minX = $x }
                    if ($x -gt $maxX) { $maxX = $x }
                    if ($y -lt $minY) { $minY = $y }
                    if ($y -gt $maxY) { $maxY = $y }
                }
            }
        }
    } finally {
        $Bmp.UnlockBits($data)
    }
    if ($maxX -lt 0) {
        throw "Source is fully transparent - cannot determine content box"
    }
    return New-Object System.Drawing.Rectangle $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)
}

function New-PaddedSquare {
    param([System.Drawing.Image]$Src, [int]$Size, [double]$Fill = 1.0)
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

# --- Master + tight crop --------------------------------------------

$rawMaster = [System.Drawing.Image]::FromFile($Source)
Write-Host ("Master (raw):     {0}x{1}" -f $rawMaster.Width, $rawMaster.Height)
$rawBmp = New-Object System.Drawing.Bitmap $rawMaster
$rawMaster.Dispose()

$box = Get-ContentBox -Bmp $rawBmp -AlphaThreshold 8
Write-Host ("Content box:      x={0} y={1} {2}x{3}" -f $box.X, $box.Y, $box.Width, $box.Height)
$master = $rawBmp.Clone($box, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$rawBmp.Dispose()
Write-Host ("Master (tight):   {0}x{1}" -f $master.Width, $master.Height)

$aspect = [math]::Round($master.Width / $master.Height, 4)
Write-Host "Aspect (W/H):     $aspect"

# --- Web: square brand marks (favicon, sidebar Logo) ----------------
# Tight crop means fill=1.0 fills the canvas with content as densely
# as the source allows. The new mascot is wider than tall so a square
# canvas still has top + bottom transparent padding — that's a
# consequence of the source aspect, not loose margins around the art.
$webBrand = Join-Path $repoRoot "apps\web\public\brand"
$webApp   = Join-Path $repoRoot "apps\web\src\app"

Save-Png (New-PaddedSquare $master 512 1.0) (Join-Path $webBrand "oddzilla-light.png")
Save-Png (New-PaddedSquare $master 512 1.0) (Join-Path $webBrand "oddzilla-dark.png")
Save-Png (New-PaddedSquare $master 512 1.0) (Join-Path $webBrand "oddzilla-logo.png")

# --- Web: wordmark (landscape rendering of the new mascot) ----------
$wmH = 800
$wmW = [int][math]::Round($wmH * $aspect)
Save-Png (New-Resized $master $wmW $wmH) (Join-Path $webBrand "wordmark-light.png")
Save-Png (New-Resized $master $wmW $wmH) (Join-Path $webBrand "wordmark-dark.png")
Save-Png (New-Resized $master $wmW $wmH) (Join-Path $webBrand "wordmark-transparent.png")

# --- Web: Next.js conventional icons (auto-picked up by metadata) ---
# Bumped icon.png to 512x512 so 2x DPI tabs / PWA installs / Android
# home-screen shortcuts pick a crisp source. apple-icon.png stays at
# 180x180 — Apple's spec is unambiguous on that exact size.
Save-Png (New-PaddedSquare $master 512 1.0) (Join-Path $webApp "icon.png")
Save-Png (New-PaddedSquare $master 180 1.0) (Join-Path $webApp "apple-icon.png")

# Open Graph image — 1200x630 per Twitter / Facebook spec, dark brand
# field with the mascot centered.
$og = New-Object System.Drawing.Bitmap 1200, 630, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ogG = [System.Drawing.Graphics]::FromImage($og)
$ogG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$ogG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$ogG.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$ogG.Clear([System.Drawing.Color]::FromArgb(255, 13, 13, 12))  # brand_ink
$boxW = 1200 * 0.86
$boxH = 630  * 0.86
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

# --- Android: adaptive launcher foreground + splash -----------------
# Adaptive icon canvas is 108x108dp; we render at xxxhdpi (4x) = 432px.
# Fill 0.86 pushes the mascot well past the 66dp guaranteed safe zone
# but stays inside the 108dp canvas. Round-masked launchers will clip
# the wide ends of the "ODDZILLA" wordmark below the shield; the shield
# itself stays prominent. Tradeoff per the user's "full size logo
# allowed there" — they want the brand to read on the home screen,
# not float in a sea of cream pixels.
$mobileDrawable = Join-Path $repoRoot "apps\mobile-android\app\src\main\res\drawable-xxxhdpi"
Save-Png (New-PaddedSquare $master 432 0.86) (Join-Path $mobileDrawable "ic_launcher_foreground.png")

# Splash screen icon. SplashScreen API renders at 288dp on a 240dp
# visible disc; keep a touch more padding than the launcher so the
# round mask doesn't bite into the mascot's spikes mid-animation.
Save-Png (New-PaddedSquare $master 432 0.74) (Join-Path $mobileDrawable "ic_splash_logo.png")

$master.Dispose()
Write-Host ""
Write-Host "Done. WORDMARK_ASPECT for monogram.tsx: $aspect"
