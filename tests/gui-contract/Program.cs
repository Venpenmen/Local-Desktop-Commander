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
Console.WriteLine("GUI CONTRACT TESTS PASSED");
