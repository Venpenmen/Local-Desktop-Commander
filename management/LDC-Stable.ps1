#Requires -Version 5.1
param(
 [ValidateSet('Start','Status','Stop','Configure','Forget','Diagnose','Network','SelfTest','Prepare')][string]$Action='Start',
 [ValidateSet('terminal','files')][string]$Mode='terminal',
 [ValidateSet('p6')][string]$Version='p6'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'LDC-Instance.ps1')
$instance = Resolve-LdcInstance $root
$store = Join-Path $env:LOCALAPPDATA ('LocalDC-Instances\' + $instance.key)
$cred=Join-Path $store 'tunnel.dpapi'
$config=Join-Path $store 'network.json'
function Assert-StorePath {
 foreach($path in (Split-Path -Parent $store),$store,$cred,$config){
  $item=Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '拒绝使用重解析的凭据或配置路径。'}
 }
}
function Save-StoreText([string]$path,[string]$value){
 Assert-StorePath
 $null=[IO.Directory]::CreateDirectory($store)
 $tmp=Join-Path $store ([guid]::NewGuid().ToString('N')+'.tmp')
 try {
  [IO.File]::WriteAllText($tmp,$value,[Text.Encoding]::UTF8)
  if([IO.File]::Exists($path)){[IO.File]::Replace($tmp,$path,$tmp+'.old')}else{[IO.File]::Move($tmp,$path)}
 } finally {[IO.File]::Delete($tmp);[IO.File]::Delete($tmp+'.old')}
}
function Save-Secret {
 $s=Read-Host '输入隧道密钥（隐藏输入，使用 DPAPI 加密保存）' -AsSecureString
 try {
  if($s.Length -eq 0){throw '密钥不能为空。'}
  Save-StoreText $cred ($s|ConvertFrom-SecureString)
  Write-Host '已为当前 Windows 用户加密保存密钥。'
 } finally {$s.Dispose()}
}
function Test-Endpoint([string]$proxy) {
 $curl=(Get-Command curl.exe -CommandType Application|Select-Object -First 1).Source
 # PS 5.1 drops empty native arguments. Use "*" for direct and a nonmatching bypass for proxy.
 $a=@('--disable','--silent','--output','NUL','--write-out','%{http_code}','--connect-timeout','2','--max-time','4')
 if($proxy){$a+=@('--noproxy','localhost,127.0.0.1','--proxy',$proxy)}else{$a+=@('--noproxy','*')}
 $a+='https://api.openai.com/v1/models'
 $code=& $curl @a
 return ($LASTEXITCODE -eq 0 -and "$code" -eq '401')
}
function Convert-LocalProxy([string]$value) {
 if(!$value){return}
 if($value -match '^(?:http://)?(?:127\.0\.0\.1|localhost):([0-9]{1,5})/?$'){
  $port=[int]$Matches[1]
  if($port -ge 1 -and $port -le 65535){return "http://127.0.0.1:$port"}
 }
}
function Get-ProxyCandidates {
 Assert-StorePath
 $values=@()
 if(Test-Path -LiteralPath $config){
  try {
   $j=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json
   $configured=Convert-LocalProxy ([string]$j.proxy)
   if(!$configured){throw 'invalid'}
   $values+=$configured
  } catch {Write-Host '已保存的代理配置无效，将尝试其他已知路径。'}

 }
 $win=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
 if($win.ProxyEnable -eq 1){
  foreach($v in ([string]$win.ProxyServer -split ';')){
   if($v -match '^(?:https|http)=(.+)$'){$v=$Matches[1]}
   $p=Convert-LocalProxy $v
   if($p){$values+=$p}
  }
 }
 foreach($n in 'HTTPS_PROXY','HTTP_PROXY'){
  $p=Convert-LocalProxy ([Environment]::GetEnvironmentVariable($n,'Process'))
  if($p){$values+=$p}
 }
 $values+='http://127.0.0.1:7897'
 return @($values|Select-Object -Unique)
}
function Get-ProxyChoice {
 $timer=[Diagnostics.Stopwatch]::StartNew()
 Write-Host '正在预检 OpenAI HTTPS，最长约 33 秒。'
 foreach($p in (Get-ProxyCandidates)){
  if($timer.Elapsed.TotalSeconds -ge 25){break}
  if(Test-Endpoint $p){return $p}
 }
 if(Test-Endpoint ''){return 'DIRECT'}
 throw 'OpenAI HTTPS 预检失败，请检查本地代理或直连。'
}
function Set-ProxyEnvironment([string]$proxy){
 foreach($n in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','CONTROL_PLANE_HTTP_PROXY'){
  [Environment]::SetEnvironmentVariable($n,$null,'Process')
 }
 if($proxy -ne 'DIRECT'){$env:HTTP_PROXY=$proxy;$env:HTTPS_PROXY=$proxy}
 $env:NO_PROXY='localhost,127.0.0.1,::1'
}
function Load-Secret {
 Assert-StorePath
 try {$s=Get-Content -LiteralPath $cred -Raw|ConvertTo-SecureString} catch {throw '加密密钥无法读取或解密，请通过菜单 12 更换。'}
 try {
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try {return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
  finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
 } finally {$s.Dispose()}
}
function Initialize-LaunchEnvironment {
 $proxy=Get-ProxyChoice
 Write-Host "OpenAI HTTPS 预检通过，路径：$proxy。隧道鉴权仍待实际连接。"
 if(!$env:CONTROL_PLANE_API_KEY){
  if(!(Test-Path -LiteralPath $cred)){Save-Secret}
  $env:CONTROL_PLANE_API_KEY=Load-Secret
  if(!$env:CONTROL_PLANE_API_KEY){throw '已保存密钥为空，请通过菜单 12 更换。'}
  Write-Host '已自动载入当前用户的加密密钥。'
 }
 Set-ProxyEnvironment $proxy
}
if($MyInvocation.InvocationName -eq '.'){return}
Assert-StorePath
if($instance.transport -eq 'local-dev'){throw '本地测试实例不使用托管隧道或 OpenAI 凭据。'}
if($Action -eq 'Network'){
 $v=Read-Host '本地 HTTP 代理（127.0.0.1:端口），AUTO 恢复自动选择，回车保留'
 if(!$v){return}
 if($v -eq 'AUTO'){if(Test-Path -LiteralPath $config){Remove-Item -LiteralPath $config};return}
 $p=Convert-LocalProxy $v
 if(!$p){throw '仅允许本机回环 HTTP 代理。'}
 Save-StoreText $config (@{proxy=$p}|ConvertTo-Json)
 Write-Host '已保存本地代理设置。'

 return
}
if($Action -eq 'Prepare'){Initialize-LaunchEnvironment;return}
if($Action -eq 'SelfTest'){
 $actual=Get-ProxyChoice
 Write-Host "LIVE_PROXY_PASS $actual"
 if((Convert-LocalProxy 'localhost:7897') -ne 'http://127.0.0.1:7897' -or (Convert-LocalProxy 'http://example.com:7897') -or (Convert-LocalProxy 'localhost:65536')){throw 'Proxy validation failed'}
 Write-Host 'PROXY_VALIDATION_PASS'
 $fake=[guid]::NewGuid().ToString('N')
 $secure=ConvertTo-SecureString $fake -AsPlainText -Force
 try {$encrypted=$secure|ConvertFrom-SecureString}finally{$secure.Dispose()}
 if($encrypted.Contains($fake)){throw 'Plaintext stored'}
 $restored=$encrypted|ConvertTo-SecureString
 try {
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($restored)
  try {if([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) -ne $fake){throw 'DPAPI mismatch'}}
  finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
 }finally{$restored.Dispose()}
 Write-Host 'DPAPI_ROUNDTRIP_PASS'
 function Get-ProxyCandidates {return @('http://127.0.0.1:7897')}
 function Test-Endpoint([string]$proxy){return (!$proxy)}
 if((Get-ProxyChoice) -ne 'DIRECT'){throw 'Fallback failed'}
 Write-Host 'DIRECT_FALLBACK_PASS'
 function Test-Endpoint([string]$proxy){return $false}
 $blocked=$false
 try {$null=Get-ProxyChoice}catch{$blocked=$true}
 if(!$blocked){throw 'Failure did not block startup'}
 Write-Host 'ALL_ROUTES_FAILED_PASS'
 return
}
if($Action -eq 'Configure'){
 Save-Secret
 return
}
if($Action -eq 'Forget'){
 if((Read-Host '清除已保存的加密密钥？输入 Y 确认') -eq 'Y' -and (Test-Path -LiteralPath $cred)){Remove-Item -LiteralPath $cred;Write-Host "已清除加密密钥。"}
 return
}
if($Action -eq 'Diagnose'){
 Write-Host ('已保存加密密钥：'+(Test-Path -LiteralPath $cred))
 Write-Host ('OpenAI HTTPS 预检通过，路径：'+(Get-ProxyChoice))
 return
}
$launcher=Join-Path $root 'engine\LocalDC.ps1'
if($Action -ne 'Start'){& $launcher -Action $Action;exit $LASTEXITCODE}
if(@(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'"|Where-Object {$_.ExecutablePath -eq (Join-Path $root 'transports\openai\bin\tunnel-client.exe')}).Count){throw '已有 Local DC 隧道运行，请通过管理菜单切换。'}
$old=@{}
foreach($n in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','CONTROL_PLANE_HTTP_PROXY','CONTROL_PLANE_API_KEY')){$old[$n]=[Environment]::GetEnvironmentVariable($n,'Process')}
try {
 Initialize-LaunchEnvironment
 if($Mode -eq 'terminal'){& $launcher -Action Start -Terminal}else{& $launcher -Action Start}
 exit $LASTEXITCODE
} finally {foreach($n in $old.Keys){[Environment]::SetEnvironmentVariable($n,$old[$n],'Process')}}