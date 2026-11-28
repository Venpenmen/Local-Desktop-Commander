using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
namespace LocalDC.Gui;
public sealed class GuiState : INotifyPropertyChanged {
 public event PropertyChangedEventHandler? PropertyChanged;
 public void Notify([CallerMemberName] string? name=null)=>PropertyChanged?.Invoke(this,new(name));
 public JsonElement Snapshot {get;private set;}
 public static string? Value(JsonElement j,params string[] path){foreach(var p in path){if(j.ValueKind!=JsonValueKind.Object||!j.TryGetProperty(p,out j))return null;}return j.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined?null:j.ToString();}
 public string? Get(params string[] path)=>Value(Snapshot,path);
 public void Apply(JsonElement j){Snapshot=j;Fresh=true;Notify("");}
 public bool Fresh {get;private set;}
 public void Invalidate(){Fresh=false;Notify("");}
 private bool busy;
 public bool Busy{get=>busy;set{busy=value;Notify("");}}
 private string message="正在读取实例…";
 public string Message{get=>message;set{message=value;Notify();}}
 public string InstanceLabel=>"实例："+(Get("instance","id")??"未知")+" · "+(Get("instance","transport")??"未知");
 public string ActualState=>!Fresh?"未知 / 状态过期":Get("actual","state") switch{"running"=>"运行中","starting"=>"启动中","stopped"=>"已停止","unsafe"=>"状态异常",_=>"未知"};
 public bool CanOperate=>Fresh&&!Busy&&Get("instance","key")!=null;
 public bool CanStart=>Get("actual","state")=="stopped";
 public bool CanStop=>Get("actual","state")=="running";
 public bool FullAvailable=>Get("instance","transport")=="openai";
 public string FullNotice=>FullAvailable?"Full 允许跨本机盘符访问，仍受 Windows ACL 和安全规则约束。":"当前开发实例禁止 Full。";
 public string ActualDetails=>$"版本：{Get("actual","version")??"—"}  工具模式：{Get("actual","mode")??"—"}  预期工具：{Get("readiness","expectedTools")??"—"}\n实际文件权限：{Get("fileAccess","actual","mode")??"未知 / 未运行"}\n实际授权根：{Get("fileAccess","actual","allowedRoot")??"—"}";
 public string TargetDetails=>$"版本：{Get("configuration","target","version")??"—"}  工具模式：{Get("configuration","target","mode")??"—"}\n目标文件权限：{Get("fileAccess","target","mode")??"—"}\n目标授权根：{Get("fileAccess","target","allowedRoot")??"—"}";
 public string RestartNotice=>Get("fileAccess","restartRequired")=="True"?"配置尚未生效，需要重启。":CanStart?"下次启动使用目标配置。":"";
 public string ConnectionDetails=>$"本地就绪：{(Get("readiness","local")=="True"?"是":"否 / 未确认")} · 远程调用：{Get("readiness","remoteInvocation")??"未验证"}";
 public string TaskDetails=>$"最近任务：{Get("task","operation")??"—"} · {Get("task","state")??"—"}";
}