using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace LocalDC.Gui;

public sealed record ToolEntry(string Name, string Category, string Status);

public sealed class GuiState : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;
    public void Notify([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    public JsonElement Snapshot { get; private set; }
    private JsonElement? inspection;
    private string inspectedKey = "";
    private string? lastInspectionError;
    private bool busy;
    private bool probing;
    private string message = "正在读取实例…";
    private string filter = "";
    private string category = "全部";
    private string activityPath = "尚未读取";
    private string tunnelPath = "尚未读取";
    private List<ToolEntry> allTools = [];

    public static string? Value(JsonElement j, params string[] path)
    {
        foreach (var p in path)
            if (j.ValueKind != JsonValueKind.Object || !j.TryGetProperty(p, out j)) return null;
        return j.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? null : j.ToString();
    }
    public string? Get(params string[] path) => Value(Snapshot, path);
    private string? Probe(params string[] path) => inspection.HasValue ? Value(inspection.Value, path) : null;
    private string CurrentKey => $"{Get("actual","state")}:{Get("actual","pid")}:{Get("actual","mode")}";
    public bool Fresh { get; private set; }

    public void Apply(JsonElement data)
    {
        Snapshot = data.Clone();
        Fresh = true;
        if (inspection.HasValue && inspectedKey != CurrentKey)
        {
            inspection = null;
            allTools.Clear();
            UpdateTools();
        }
        Notify("");
    }
    public void Invalidate()
    {
        Fresh = false;
        Notify("");
    }
    public bool Busy { get => busy; set { busy = value; Notify(""); } }
    public bool Probing { get => probing; set { probing = value; Notify(""); } }
    public string Message { get => message; set { message = value; Notify(); } }
    public bool CanOperate => Fresh && !Busy && Get("instance","key") is not null;
    public bool CanStart => Get("actual","state") == "stopped";
    public bool CanStop => Get("actual","state") == "running";
    public bool FullAvailable => Get("instance","transport") == "openai";
    public string FullNotice => FullAvailable
        ? "Full 允许跨本机盘符访问，仍受 Windows ACL 限制。"
        : "本地开发实例禁止 Full。";
    public string InstanceLabel => $"实例：{Get("instance","id") ?? "未知"} · {Get("instance","transport") ?? "未知"}";
    public string ActualState => !Fresh ? "未知 / 状态过期" : Get("actual","state") switch
    {
        "running" => "运行中", "starting" => "启动中",
        "stopped" => "已停止", "unsafe" => "状态异常", _ => "未知"
    };
    public string ActualDetails =>
        $"版本：{Get("actual","version") ?? "—"}  工具模式：{Get("actual","mode") ?? "—"}\n" +
        $"进程 PID：{Get("actual","pid") ?? "—"}  启动：{StartedAt}  已运行：{Uptime}\n" +
        $"实际文件权限：{Get("fileAccess","actual","mode") ?? "未知 / 未运行"}\n" +
        $"实际授权根：{Get("fileAccess","actual","allowedRoot") ?? "—"}";
    private DateTime? BirthDate =>
        long.TryParse(Get("actual","birth"), out var ticks) && ticks > DateTime.MinValue.Ticks &&
        ticks < DateTime.MaxValue.Ticks ? new DateTime(ticks, DateTimeKind.Utc) : null;
    public string StartedAt => BirthDate?.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") ?? "—";
    public string Uptime => BirthDate is { } date && date < DateTime.UtcNow
        ? (DateTime.UtcNow - date).ToString(@"d\.hh\:mm\:ss") : "—";
    public string TargetDetails =>
        $"版本：{Get("configuration","target","version") ?? "—"}  工具模式：{Get("configuration","target","mode") ?? "—"}\n" +
        $"回滚：{Get("configuration","rollback","version") ?? "—"} · {Get("configuration","rollback","mode") ?? "—"}\n" +
        $"目标文件权限：{Get("fileAccess","target","mode") ?? "—"}\n" +
        $"目标授权根：{Get("fileAccess","target","allowedRoot") ?? "—"}";
    public string RestartNotice => Get("fileAccess","restartRequired") == "True"
        ? "配置尚未生效，需要重启。" : CanStart ? "下次启动使用目标配置。" : "";
    public string ConnectionDetails =>
        $"本地就绪：{(Get("readiness","local") == "True" ? "是" : "否 / 未确认")} · " +
        $"远程调用：{Get("readiness","remoteInvocation") ?? "未验证"}";
    public string TaskDetails => $"最近任务：{Get("task","operation") ?? "—"} · {Get("task","state") ?? "—"}";
    public string ObservedTime => DateTimeOffset.TryParse(Get("observedUtc"), out var time)
        ? time.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") : "—";

    private string? TransportValue(params string[] path)
    {
        if (Snapshot.ValueKind != JsonValueKind.Object ||
            !Snapshot.TryGetProperty("transports", out var t) ||
            t.ValueKind != JsonValueKind.Array || t.GetArrayLength() == 0) return null;
        return Value(t[0], path);
    }
    public string TransportDetails =>
        $"类型：{TransportValue("id") ?? "未知"} / {TransportValue("type") ?? "未知"}\n" +
        $"连接：{TransportValue("connection") ?? "未观察"}\n" +
        $"支持能力：{string.Join("、", TransportCapabilities)}";
    private IEnumerable<string> TransportCapabilities =>
        Snapshot.ValueKind == JsonValueKind.Object &&
        Snapshot.TryGetProperty("transports", out var transports) &&
        transports.ValueKind == JsonValueKind.Array && transports.GetArrayLength() > 0 &&
        transports[0].TryGetProperty("capabilities", out var caps) &&
        caps.ValueKind == JsonValueKind.Array
            ? caps.EnumerateArray().Select(x => x.GetString() ?? "").ToArray() : [];
    public string HealthDetails =>
        $"healthz：{Probe("http","healthz") ?? TransportValue("health","Health") ?? "未检测"}  " +
        $"readyz：{Probe("http","readyz") ?? TransportValue("health","Ready") ?? "未检测"}\n" +
        $"MCP HTTP：{Probe("http","mcp") ?? TransportValue("health","McpHttp") ?? "未检测"}  " +
        $"MCP 状态：{Probe("control","mcpState") ?? TransportValue("health","McpState") ?? "未知"}\n" +
        $"控制平面：{Probe("control","status") ?? TransportValue("health","ControlStatus") ?? "不适用"} / " +
        $"{Probe("control","state") ?? TransportValue("health","Control") ?? "不适用"}\n" +
        $"连续轮询失败：{Probe("control","pollFailures") ?? TransportValue("health","PollFailures") ?? "未观测"}";
    public string LayerDetails
    {
        get
        {
            var first = Get("actual","state") == "running" && Get("readiness","local") == "True" ? "正常"
                : Get("actual","state") == "unsafe" ? "异常" : "未就绪";
            var second = InspectionStatus == "ok" ? "正常"
                : InspectionStatus == "mismatch" ? "工具不一致"
                : InspectionStatus == "failed" ? "检测失败" : "未验证";
            var third = Get("instance","transport") == "local-dev"
                ? "不适用（本地代理）" : "需检查托管传输";
            return $"L1 本地引擎：{first}\nL2 MCP 协议：{second}\n" +
                   $"L3 公网传输：{third}\nL4 远程客户端：未验证（需客户端实际调用）";
        }
    }
    public string LogDetails => $"运行日志：{tunnelPath}\n操作记录：{activityPath}";
    public void ApplyLogLocations(JsonElement data)
    {
        activityPath = Value(data, "activityPath") ?? "未知";
        tunnelPath = Value(data, "tunnelPath") ?? "未知";
        Notify("");
    }
    public string Endpoint => Probe("endpoint") ?? "未检测 / 当前无可复制的本地 MCP 地址";
    public bool HasEndpoint => Fresh && InspectionStatus is ("ok" or "mismatch") &&
                               Probe("endpoint")?.StartsWith("http://127.0.0.1:", StringComparison.Ordinal) == true;
    public string InspectionStatus =>
        !Fresh ? "stale" :
        inspectedKey.Length == 0 ? "unverified" :
        inspectedKey != CurrentKey ? "stale" :
        lastInspectionError is not null && inspection is null ? "failed" :
        Probe("status") switch
        {
            "ok" => "ok", "mismatch" => "mismatch",
            "unavailable" => "failed", _ => "unverified"
        };
    public bool ProbeFresh => InspectionStatus is "ok" or "mismatch";
    public string ExpectedToolCount =>
        ProbeFresh ? Probe("counts","expected") ?? "—" : Get("readiness","expectedTools") ?? "—";
    public string ActualToolCount => ProbeFresh ? Probe("counts","actual") ?? "—" : "未检测";
    public string ToolDiff =>
        ProbeFresh ? $"缺失 {ProbeArray("missing").Length} 项 · 额外 {ProbeArray("extra").Length} 项" : "未验证差异";
    public string ToolSummary => InspectionStatus switch
    {
        "ok" => "工具名称与数量一致",
        "mismatch" => "工具集合存在差异",
        "failed" => $"工具发现失败：{lastInspectionError ?? Probe("error") ?? "未知"}",
        "stale" => "检测结果已过期，请重新检测",
        _ => Probing ? "正在通过 MCP 查询工具…" : "尚未进行实际 MCP 工具发现"
    };
    public string ToolCheckedAt => ProbeFresh
        ? (DateTimeOffset.TryParse(Probe("checkedUtc"), out var t)
            ? t.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") : "未知") : "未检测";
    public string ToolDescription => $"预期 {ExpectedToolCount} · 实际 {ActualToolCount} · {ToolDiff}";
    private string[] ProbeArray(string name)
    {
        if (!inspection.HasValue || !inspection.Value.TryGetProperty(name, out var a) ||
            a.ValueKind != JsonValueKind.Array) return [];
        return a.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => x.GetString() ?? "").ToArray();
    }
    public ObservableCollection<ToolEntry> Tools { get; } = new();
    public string ToolSearch { get => filter; set { filter = value ?? ""; UpdateTools(); } }
    public string ToolCategory { get => category; set { category = value ?? "全部"; UpdateTools(); } }
    private void UpdateTools()
    {
        Tools.Clear();
        foreach (var entry in allTools)
        {
            if (!string.IsNullOrWhiteSpace(filter) &&
                !entry.Name.Contains(filter.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
            if (category != "全部" && category != entry.Category &&
                !(category == "异常" && entry.Status != "正常")) continue;
            Tools.Add(entry);
        }
        Notify(nameof(Tools));
    }
    public void ClearInspection()
    {
        inspection = null; inspectedKey = ""; lastInspectionError = null;
        allTools.Clear(); UpdateTools(); Notify("");
    }
    public bool ApplyInspection(JsonElement data, string originalKey)
    {
        if (!Fresh || CurrentKey != originalKey) return false;
        inspection = data.Clone(); inspectedKey = originalKey;
        lastInspectionError = Probe("error");
        var fileNames = ProbeArray("fileCatalog").ToHashSet(StringComparer.Ordinal);
        var actualNames = ProbeArray("actual");
        var missingNames = ProbeArray("missing");
        var extraNames = ProbeArray("extra").ToHashSet(StringComparer.Ordinal);
        allTools = actualNames.Select(x => new ToolEntry(x, fileNames.Contains(x) ? "文件工具" : "终端工具",
            extraNames.Contains(x) ? "额外" : "正常"))
            .Concat(missingNames.Select(x => new ToolEntry(x, fileNames.Contains(x) ? "文件工具" : "终端工具", "缺失")))
            .OrderBy(x => x.Category).ThenBy(x => x.Name, StringComparer.Ordinal).ToList();
        UpdateTools();
        Notify("");
        return true;
    }
    public string InspectionKey => CurrentKey;
    public void FailInspection(string error, string originalKey)
    {
        if (CurrentKey != originalKey) return;
        lastInspectionError = error;
        inspection = null; inspectedKey = originalKey;
        allTools.Clear(); UpdateTools(); Notify("");
    }
    public string DiagnosticsAdvice =>
        Get("actual","state") == "unsafe" ? "实例进程归属异常：停止自动处理，请通过 TUI 核对。" :
        Get("actual","state") == "stopped" ? "实例未运行：可在概览中确认启动后重新诊断。" :
        !Fresh ? "状态过期：重新读取管理状态后再诊断。" :
        InspectionStatus == "mismatch" ? "MCP 工具名称不一致：核查当前运行模式与工具清单。" :
        InspectionStatus == "failed" ? "MCP 发现失败：确认本地端口与服务就绪，再手动重试。" :
        InspectionStatus == "ok" ? "本地引擎与 MCP 发现通过；远程客户端仍需实际验证。" :
        "尚未完成 MCP 协议诊断。";
}
