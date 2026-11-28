using System.Text.Json;
using LocalDC.Gui;

var workspace = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
if (args.Length > 0) workspace = Path.GetFullPath(args[0]);
var client = new ManagementClient(workspace);
static void Require(bool value, string description) {if(!value)throw new Exception("FAIL "+description);Console.WriteLine("PASS "+description);}
try {
    await client.RequestAsync("config.get");
    throw new Exception("unbound client accepted config.get");
} catch (InvalidOperationException e) when(e.Message.Contains("state")) {
    Console.WriteLine("PASS initial state binding required");
}
var state = await client.RequestAsync("state");
var key = GuiState.Value(state,"instance","key");
Require(!string.IsNullOrWhiteSpace(key)&&client.InstanceKey==key,"state binds instance key");
Require(GuiState.Value(state,"instance","id")=="gui","real GUI instance");
Require(GuiState.Value(state,"instance","transport")=="local-dev","isolated development transport");
Require(GuiState.Value(state,"fileAccess","target","mode")=="restricted","restricted file target");
Require(GuiState.Value(state,"configuration","revision")?.Length==64,"configuration revision read");
var config = await client.RequestAsync("config.get");
Require(GuiState.Value(config,"revision")==GuiState.Value(state,"configuration","revision"),"config.get roundtrip");
var caps = await client.RequestAsync("capabilities");
Require(caps.GetProperty("operations").EnumerateArray().Any(x=>x.GetString()=="access.set"),"access.set announced");
Require(caps.GetProperty("operations").EnumerateArray().Any(x=>x.GetString()=="start"),"service operations announced");
var versions = await client.RequestAsync("versions");
Require(versions.ValueKind==JsonValueKind.Array&&versions.GetArrayLength()>0,"versions array");
var vm=new GuiState();vm.Apply(state);
Require(vm.Fresh&&vm.InstanceLabel.Contains("gui"),"state view model binds observed instance");
Require(vm.FullAvailable==false,"local-dev Full UI gate");
Require(vm.TargetDetails.Contains("restricted"),"target summary");
try {
    await client.RequestAsync("state", timeout: TimeSpan.FromMilliseconds(1));
    throw new Exception("Expected read timeout was not reported");
} catch (TimeoutException e) when (e.Message.Contains("超时")) {
    Console.WriteLine("PASS bounded management client timeout");
}
Require(GuiState.Value(await client.RequestAsync("state"),"instance","key")==key,
    "client recovers from a read timeout without instance switching");

Require(vm.ActualDetails.Contains("进程 PID"),"detailed GUI status includes PID");
Require(vm.TargetDetails.Contains("回滚"),"GUI reads rollback version");
var logLocations = await client.RequestAsync("logs");
vm.ApplyLogLocations(logLocations);
Require(vm.LogDetails.Contains("tunnel.log") && vm.LogDetails.Contains("activity.log"),
    "GUI reuses management redacted log locations");
Require(vm.TransportDetails.Contains("health"),
    "GUI reads adapter-declared transport capabilities");
Require(vm.LayerDetails.Contains("L4 远程客户端"),"four-layer client state does not infer remote verification");
var notReady = System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
notReady["readiness"]!["local"] = false;
using(var notReadyDoc = JsonDocument.Parse(notReady.ToJsonString()))
{
    vm.Apply(notReadyDoc.RootElement);
    Require(vm.LayerDetails.Contains("未就绪"),
        "loss of readiness is not silently reported as healthy");
}
vm.Apply(state);
Require(vm.ToolDescription.Contains("未检测"),"pre-discovery actual count is explicitly unknown");

var startingState = System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
startingState["actual"]!["state"] = "starting";
using(var startingDoc = JsonDocument.Parse(startingState.ToJsonString()))
{
    vm.Apply(startingDoc.RootElement);
    Require(vm.ActualState=="启动中" && vm.ServiceSummary.Contains("等待服务就绪"),
        "starting engine clearly differs from ready service");
}
var stoppedState = System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
stoppedState["actual"]!["state"] = "stopped";
using(var stoppedDoc = JsonDocument.Parse(stoppedState.ToJsonString()))
{
    vm.Apply(stoppedDoc.RootElement);
    Require(vm.ActualState=="已停止" && vm.ToolCountHeadline.StartsWith("—/"),
        "stopped engine never displays fake zero tools");
}
var unsafeState = System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
unsafeState["actual"]!["state"] = "unsafe";
using(var unsafeDocument = JsonDocument.Parse(unsafeState.ToJsonString()))
{
    vm.Apply(unsafeDocument.RootElement);
    Require(vm.ActualState=="状态异常" && vm.DiagnosticsAdvice.Contains("进程归属异常"),
        "unsafe PID disables recovery assumptions");
    Require(vm.HasSafetyNotice && vm.SafetyNotice.Contains("进程归属异常"),
        "unsafe ownership warning remains visible in streamlined overview");
}
var pendingState = System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
pendingState["fileAccess"]!["restartRequired"] = true;
using(var pendingDocument = JsonDocument.Parse(pendingState.ToJsonString()))
{
    vm.Apply(pendingDocument.RootElement);
    Require(vm.HasSafetyNotice && vm.SafetyNotice.Contains("尚未生效"),
        "pending permission restart warning remains visible");
}
var hostedState = System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
hostedState["instance"]!["transport"] = "openai";
using(var hostedDocument = JsonDocument.Parse(hostedState.ToJsonString()))
{
    vm.Apply(hostedDocument.RootElement);
    Require(!vm.HasEndpoint && vm.LayerDetails.Contains("需检查托管传输"),
        "hosted adapter uses separate transport level without fabricated remote success");
}
vm.Apply(state);
using(var failedDocument = JsonDocument.Parse(
    "{\"schema\":1,\"status\":\"unavailable\",\"error\":\"MCP_TIMEOUT\"}"))
{
    Require(vm.ApplyInspection(failedDocument.RootElement, vm.InspectionKey),
        "failed diagnostic accepted only for current process identity");
    Require(vm.InspectionStatus=="failed" && vm.ToolSummary.Contains("MCP_TIMEOUT"),
        "diagnostic failure displayed, not treated as zero tools");
}
vm.ClearInspection();

if(GuiState.Value(state,"actual","state")=="running" &&
   GuiState.Value(state,"instance","transport")=="local-dev")
{

    var inspector = new McpDiagnostics(workspace);
    using var stopped = JsonDocument.Parse(
        state.GetRawText().Replace("\"running\"","\"stopped\""));
    try {
        await inspector.InspectAsync(stopped.RootElement);
        throw new Exception("Stopped instance was probed");
    } catch (InvalidOperationException e) when(e.Message.Contains("未运行")) {
        Console.WriteLine("PASS stopped MCP probe rejected without network");
    }
    try {
        await inspector.InspectAsync(state, TimeSpan.FromMilliseconds(1));
        throw new Exception("Expected inspector timeout");
    } catch (TimeoutException e) when(e.Message.Contains("超时")) {
        Console.WriteLine("PASS inspector timeout only cancels owned inspection child");
    }
    Require(GuiState.Value(await client.RequestAsync("state"),"actual","state")=="running",
        "inspector timeout does not stop the MCP engine");
    var probe = await new McpDiagnostics(workspace).InspectAsync(state);
    Require(GuiState.Value(probe,"status")=="ok","live B3 MCP inspection connected");
    Require(GuiState.Value(probe,"counts","actual")==GuiState.Value(state,"readiness","expectedTools"),
        "live discovered count agrees with configured mode");
    Require(probe.GetProperty("fileCatalog").GetArrayLength()==14,"independent file catalog has 14 names");
    Require(vm.ApplyInspection(probe,vm.InspectionKey),"live probe belongs to current PID and mode");
    Require(vm.ProbeFresh && vm.ActualToolCount==vm.ExpectedToolCount,"GUI binds actual tool count");
    vm.ToolCategory="异常";
    Require(vm.Tools.Count==0,"no unexpected or missing tools after valid discovery");
    vm.ToolCategory="全部";
    vm.ToolSearch="list_directory";
    Require(vm.Tools.Count==1,"GUI tool-name search");
    vm.ToolSearch="";
    Require(vm.Tools.Count==probe.GetProperty("actual").GetArrayLength(),"GUI tool list restored after filter");
    vm.ToolCategory="文件工具";
    Require(vm.Tools.Count==14,"GUI file category derives from independent installed engine");
    vm.ToolCategory="终端工具";
    Require(vm.Tools.Count==(GuiState.Value(state,"actual","mode")=="terminal"?7:0),
        "GUI terminal category accurately distinguishes seven terminal additions");
    vm.ToolCategory="全部";
    Require(vm.HealthDetails.Contains("healthz") && vm.HasEndpoint,
        "local health and loopback endpoint visible");
    var later = state.Clone();
    vm.Invalidate();
    Require(!vm.ProbeFresh,"outdated MCP probe is not presented as live");
    vm.Apply(later);
}
vm.Invalidate();
Require(!vm.Fresh,"invalidating stale UI state disables it");
vm.Apply(state);
Require(vm.Fresh,"fresh read restores UI state");
try {
    await client.RequestAsync("not-real");
    throw new Exception("unknown op accepted");
} catch(InvalidOperationException e) when(e.Message.Contains("INVALID_REQUEST")||e.Message.Contains("UNKNOWN_OPERATION")){
    Console.WriteLine("PASS structured operation error");
}
// B4 bounded, redacted log presentation and proxy rules; no network mutations.
var logModel = new B4LogCenter();
var sample = new {
    tunnel = Enumerable.Range(0, 230).Select(i =>
        $"2026-11-28T13:00:00Z {(i % 10 == 0 ? "WARN" : "INFO")} sample-log-{i} token=hidden-secret"),
    events = Enumerable.Range(0, 40).Select(i => new {
        utc=$"2026-11-28T13:00:{i:D2}Z",kind="change",
        version="p6",mode="terminal",pid=100,code=i%7==0?1:0
    })
};
using(var sourceDoc=JsonDocument.Parse(JsonSerializer.Serialize(sample)))
{
    logModel.Apply(sourceDoc.RootElement);
    Require(logModel.Count == 200 && logModel.Rows.Count == 200,
        "B4 log cache always bounded at 200 records");
    logModel.Apply(sourceDoc.RootElement);
    Require(logModel.Count == 200,"B4 repeat polling does not add duplicates");
}
Require(!logModel.ExportText.Contains("hidden-secret") && logModel.ExportText.Contains("[凭据信息已隐藏]"),
    "B4 redacted log export never includes sample secrets");
logModel.Source = "管理事件";
Require(logModel.Rows.Count > 0 && logModel.Rows.All(x=>x.Source=="管理事件"),
    "B4 source filter");
logModel.Level = "ERROR";
Require(logModel.Rows.Count > 0 && logModel.Rows.All(x=>x.Level=="ERROR"),
    "B4 severity filter");
logModel.Search="not-found-unique";
Require(logModel.Rows.Count==0,"B4 search no-match state");
logModel.Source="全部";logModel.Level="全部";logModel.Search="";
Require(logModel.Rows.Count==200,"B4 filters reset to full cache");
var danger="Authorization: Bearer abc1234, API_KEY=secret123 sk-test1234567890 C:\\Users\\private\\key.txt https://local.test/path?token=private";
var safe=B4LogCenter.Redact(danger);
Require(!safe.Contains("secret123")&&!safe.Contains("test123")&&
        !safe.Contains("C:\\Users")&&!safe.Contains("token=private"),
    "B4 redaction covers credentials, local paths and URL queries");
using(var brokenLogs=JsonDocument.Parse("[]"))
{
    try { logModel.Apply(brokenLogs.RootElement); throw new Exception("Log schema accepted array"); }
    catch(InvalidDataException) {Console.WriteLine("PASS B4 malformed log schema rejected");}
}
Require(B4Proxy.TryNormalize(null,out var autoProxy) && autoProxy is null,
    "B4 automatic proxy mode");
Require(B4Proxy.TryNormalize("http://localhost:7897/",out var normalizedProxy) &&
        normalizedProxy=="http://127.0.0.1:7897","B4 loopback HTTP proxy canonicalized");
foreach(var invalid in new[]{"http://example.org:7897","socks5://127.0.0.1:7897",
    "127.0.0.1:0","127.0.0.1:65536","127.0.0.1:abc",
    "http://user:pwd@localhost:7897","https://127.0.0.1:7897"})
{
    Require(!B4Proxy.TryNormalize(invalid,out _),"B4 rejects invalid proxy "+invalid);
}
Require(!B4Proxy.IsHosted("local-dev")&&B4Proxy.IsHosted("openai"),
    "B4 only hosted OpenAI adapter exposes proxy actions");
vm.Apply(state);
Require(!vm.CanManageHosted && vm.ProxyStatus.Contains("不使用") &&
    vm.CredentialStatus.Contains("不使用"),"B4 local-dev refuses hosted proxy/credential features");
Console.WriteLine("B4 GUI CONTRACT TESTS PASSED");
// B5: registered versions are obtained only from the shared management API.
var registry=new B5Versions();
registry.Apply(versions,state);
Require(registry.Fresh && registry.Entries.Count>0 && registry.TargetId=="p6",
    "B5 reads true registered versions and target");
Require(registry.ActualId=="p6" && registry.InstanceKey==key,
    "B5 actual version is bound to verified instance key");
Require(registry.Entries.Count==1 && (registry.HasDistinctRollback
    ? registry.RollbackNotice.Contains("工具模式")
    : registry.RollbackNotice.Contains("暂无")),
    "B5 single P6 registry distinguishes valid mode-only rollback from cross-version rollback");
Require(registry.InstallationNotice.Contains("公共版本生命周期接口") &&
        caps.GetProperty("operations").EnumerateArray().Any(x=>x.GetString()=="version.install") &&
        caps.GetProperty("operations").EnumerateArray().Any(x=>x.GetString()=="version.verify") &&
        caps.GetProperty("operations").EnumerateArray().Any(x=>x.GetString()=="version.activate") &&
        caps.GetProperty("operations").EnumerateArray().Any(x=>x.GetString()=="version.remove"),
    "B5 management v1 backward-compatible lifecycle extension advertised and surfaced");
Require(B5Versions.NeedsManagedActivation(new RegisteredVersion("canarya","A","installed-verified",14,21)) &&
        !B5Versions.NeedsManagedActivation(new RegisteredVersion("p6","P6","legacy",14,21)),
    "B5 managed versions must use checked activation rather than unverified legacy select");
var syntheticRegistry=System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
syntheticRegistry["configuration"]!["rollback"]!["version"]="canarya";
using(var syntheticVersions=JsonDocument.Parse(
    "[{\"Id\":\"p6\",\"Label\":\"P6\",\"Status\":\"legacy\",\"FilesTools\":14,\"TerminalTools\":21}," +
    "{\"Id\":\"canarya\",\"Label\":\"A\",\"Status\":\"installed-verified\",\"FilesTools\":14,\"TerminalTools\":21}]"))
using(var syntheticState=JsonDocument.Parse(syntheticRegistry.ToJsonString()))
{
    registry.Apply(syntheticVersions.RootElement,syntheticState.RootElement);
    Require(registry.IsManagedRollback && registry.RollbackNotice.Contains("完整性校验"),
        "B5 managed rollback must route through verify and checked activation");
}
registry.Apply(versions,state);
using(var emptyVersions=JsonDocument.Parse("[]"))
{
    try {registry.Apply(emptyVersions.RootElement,state);throw new Exception("empty registry accepted");}
    catch(InvalidDataException) { Console.WriteLine("PASS B5 empty registry refused"); }
}
var duplicated="[{\"Id\":\"p6\",\"Label\":\"P6\",\"Status\":\"stable\",\"FilesTools\":14,\"TerminalTools\":21}," +
               "{\"Id\":\"p6\",\"Label\":\"clone\",\"Status\":\"stable\",\"FilesTools\":14,\"TerminalTools\":21}]";
using(var duplicates=JsonDocument.Parse(duplicated))
{
    try {registry.Apply(duplicates.RootElement,state);throw new Exception("duplicate registry accepted");}
    catch(InvalidDataException) {Console.WriteLine("PASS B5 duplicated version refused");}
}
var revised=System.Text.Json.Nodes.JsonNode.Parse(state.GetRawText())!;
revised["configuration"]!["rollback"]!["mode"]="files";
revised["configuration"]!["target"]!["mode"]="terminal";
using(var revisedDoc=JsonDocument.Parse(revised.ToJsonString()))
{
    registry.Apply(versions,revisedDoc.RootElement);
    Require(registry.HasDistinctRollback && registry.RollbackNotice.Contains("工具模式"),
        "B5 one-version rollback correctly identified as mode-only, not version upgrade");
}
registry.Apply(versions,state);
foreach(var v in new[]{
    ("v1.2.0","v1.1.9",1),("v1.0.0","v1.0.0",0),
    ("v1.2.0-rc.1","v1.2.0",-1),("v1.2.0-rc.2","v1.2.0-rc.1",1),
    ("v1.2.0-rc.1","v1.2.0-beta.8",1),("v1.2.0+build.2","v1.2.0",0)
})
{
    Require(Math.Sign(B5ReleaseFeed.CompareTags(v.Item1,v.Item2))==v.Item3,
        "B5 semantic release comparison "+v.Item1+" vs "+v.Item2);
}
try {B5ReleaseFeed.CompareTags("P6","v1.0.0");throw new Exception("P6 compared as release");}
catch(ArgumentException){Console.WriteLine("PASS B5 internal engine P6 cannot be compared to release semver");}

var zipRoot=Path.Combine(workspace,"test-runtime","b5-package-contract");
Directory.CreateDirectory(zipRoot);
var goodZip=Path.Combine(zipRoot,"safe.zip");
void MakeZip(string where, params (string Path, string Content, bool Symlink)[] entries)
{
    using var f=File.Create(where);
    using var z=new System.IO.Compression.ZipArchive(f,System.IO.Compression.ZipArchiveMode.Create);
    foreach(var item in entries)
    {
        var e=z.CreateEntry(item.Path);
        if(item.Symlink)e.ExternalAttributes=unchecked((int)0xA0000000);
        using var w=new StreamWriter(e.Open()); w.Write(item.Content);
    }
}
try
{
    MakeZip(goodZip,("manifest.json","{\"version\":\"fixture\"}",false),
        ("bin/engine.exe","harmless synthetic fixture bytes",false));
    var sha=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        await File.ReadAllBytesAsync(goodZip))).ToLowerInvariant();
    var verified=await B5PackageInspector.InspectAsync(goodZip,sha,CancellationToken.None);
    Require(verified.ExpectedMatched && verified.Entries==2 && verified.Sha256==sha,
        "B5 local ZIP synthetic SHA-256 verified with explicit expected digest");
    var unknown=await B5PackageInspector.InspectAsync(goodZip,null,CancellationToken.None);
    Require(!unknown.ExpectedMatched && unknown.Description.Contains("尚未提供可信"),
        "B5 checksum-only scan never claims independent trust");
    try{await B5PackageInspector.InspectAsync(goodZip,new string('0',64),CancellationToken.None);
        throw new Exception("wrong sha accepted");}
    catch(InvalidDataException){Console.WriteLine("PASS B5 invalid SHA-256 rejected");}
    try{await B5PackageInspector.InspectAsync(goodZip,"invalid",CancellationToken.None);
        throw new Exception("malformed sha accepted");}
    catch(InvalidDataException){Console.WriteLine("PASS B5 malformed SHA-256 rejected");}
    var evil=Path.Combine(zipRoot,"traversal.zip");
    MakeZip(evil,("../escaped.txt","bad",false));
    try{await B5PackageInspector.InspectAsync(evil,null,CancellationToken.None);
        throw new Exception("ZipSlip accepted");}
    catch(InvalidDataException){Console.WriteLine("PASS B5 zip path traversal refused");}
    var link=Path.Combine(zipRoot,"symlink.zip");
    MakeZip(link,("bin/link","target",true));
    try{await B5PackageInspector.InspectAsync(link,null,CancellationToken.None);
        throw new Exception("symlink accepted");}
    catch(InvalidDataException){Console.WriteLine("PASS B5 ZIP symbolic link refused");}
    var duplicate=Path.Combine(zipRoot,"duplicate.zip");
    MakeZip(duplicate,("Bin/A.txt","one",false),("bin/a.txt","two",false));
    try{await B5PackageInspector.InspectAsync(duplicate,null,CancellationToken.None);
        throw new Exception("conflicting entries accepted");}
    catch(InvalidDataException){Console.WriteLine("PASS B5 duplicate and case-conflicting ZIP paths refused");}
    try{await B5PackageInspector.InspectAsync(goodZip,null,new CancellationToken(true));
        throw new Exception("cancellation ignored");}
    catch(OperationCanceledException){Console.WriteLine("PASS B5 inspection cancel prevents ongoing work");}
}
finally {Directory.Delete(zipRoot,true);}
Console.WriteLine("B5 GUI CONTRACT TESTS PASSED");
Console.WriteLine("GUI CONTRACT TESTS PASSED");
