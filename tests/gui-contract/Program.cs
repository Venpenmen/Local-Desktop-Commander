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
Console.WriteLine("GUI CONTRACT TESTS PASSED");
