# Local preview without Node: serves the public/ folder on http://localhost:8123
# The AI endpoints are not available here (they run on Vercel), so the page shows "AI not connected".
param([int]$Port = 8123)
$root = Join-Path $PSScriptRoot 'public'
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Preview running at http://localhost:$Port  (Ctrl+C to stop)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')
    $full = [System.IO.Path]::GetFullPath($file)
    if ($path -like '/api/*') {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"aiConnected":false,"model":"","error":"AI is not available in the local preview. Deploy to Vercel."}')
      $ctx.Response.StatusCode = $(if ($path -eq '/api/status') { 200 } else { 503 })
      $ctx.Response.ContentType = 'application/json'
    } elseif ($full.StartsWith($root) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
    } else {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not found'); $ctx.Response.StatusCode = 404
    }
    try {
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      if ($ctx.Request.HttpMethod -ne 'HEAD') {
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      $ctx.Response.Close()
    } catch { try { $ctx.Response.Abort() } catch {} }
  }
} finally { $listener.Stop() }
