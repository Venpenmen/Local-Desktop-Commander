using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace LocalDC.Gui;

public sealed record RegisteredVersion(string Id, string Label, string Status, int FilesTools, int TerminalTools)
{
    public string Display => $"{Label} · {Id}";
    public string Tools => $"文件 {FilesTools} / 终端 {TerminalTools}";
}

/// <summary>Only describes entries returned by the shared management v1 API. Never edits the registry.</summary>
public sealed class B5Versions : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;
    private readonly ObservableCollection<RegisteredVersion> entries = [];
    private string status = "尚未读取已注册版本";
    private string? lastError;
    public ReadOnlyObservableCollection<RegisteredVersion> Entries { get; }
    public B5Versions() => Entries = new(entries);
    public string Status { get => status; private set { status = value; Notify(); } }
    public string? LastError => lastError;
    public bool Fresh { get; private set; }
    public string? Revision { get; private set; }
    public string? TargetId { get; private set; }
    public string? TargetMode { get; private set; }
    public string? ActualId { get; private set; }
    public string? ActualMode { get; private set; }
    public string? RollbackId { get; private set; }
    public string? RollbackMode { get; private set; }
    public string? InstanceKey { get; private set; }
    public string? ActualState { get; private set; }
    public string ActualHeadline => Fresh
        ? $"{ActualId ?? "—"} · {ActualMode ?? "未知"} ({ActualState ?? "未知"})"
        : "状态尚未验证";
    public string TargetHeadline => Fresh
        ? $"{TargetId ?? "—"} · {TargetMode ?? "未知"}" : "未知";
    public string RollbackHeadline => Fresh
        ? $"{RollbackId ?? "—"} · {RollbackMode ?? "未知"}" : "未知";
    public bool HasDistinctRollback => Fresh &&
        RollbackId is not null && entries.Any(x=>x.Id==RollbackId) &&
        (TargetId != RollbackId || TargetMode != RollbackMode);
    public string RollbackNotice => !Fresh ? "版本状态尚未刷新" :
        RollbackId is null || !entries.Any(x=>x.Id==RollbackId) ? "没有已注册且可用的回滚目标" :
        !HasDistinctRollback ? "回滚目标与当前配置相同，暂无可执行的回滚" :
        RollbackId == TargetId ? "当前回滚候选仅切换工具模式，并非跨版本回滚" :
        "已注册另一版本作为回滚目标；实际切换仍需确认和健康检查";
    public string InstallationNotice => "当前共享管理 API v1 未提供安装、注册或删除版本的操作；安装包仅可离线预检。";
    public bool CanChoose(string? version) =>
        Fresh && version is not null && entries.Any(x=>x.Id==version);
    public void Apply(JsonElement versions, JsonElement snapshot)
    {
        if(versions.ValueKind!=JsonValueKind.Array) throw new InvalidDataException("versions 返回类型错误");
        var list = new List<RegisteredVersion>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach(var x in versions.EnumerateArray())
        {
            var id = GuiState.Value(x,"Id") ?? GuiState.Value(x,"id");
            var label=GuiState.Value(x,"Label") ?? GuiState.Value(x,"label");
            var status=GuiState.Value(x,"Status") ?? GuiState.Value(x,"status");
            var f=GuiState.Value(x,"FilesTools") ?? GuiState.Value(x,"filesTools");
            var t=GuiState.Value(x,"TerminalTools") ?? GuiState.Value(x,"terminalTools");
            if(id is null || !System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z0-9-]{1,40}$") ||
               !keys.Add(id) || !int.TryParse(f,out var files) || !int.TryParse(t,out var terminal) ||
               files<1 || terminal<files || terminal>256)
                throw new InvalidDataException("版本注册表包含无效或重复条目");
            list.Add(new(id,(label ?? id)[..Math.Min((label ?? id).Length,80)],
                (status ?? "状态未说明")[..Math.Min((status ?? "状态未说明").Length,80)],files,terminal));
        }
        if(list.Count==0 || list.Count>32) throw new InvalidDataException("版本注册表为空或超出上限");
        string? ver(string section,string field)=>GuiState.Value(snapshot,"configuration",section,field);
        var target=ver("target","version");
        var rollback=ver("rollback","version");
        var actual=GuiState.Value(snapshot,"actual","version");
        if(target is null || !list.Any(x=>x.Id==target))
            throw new InvalidDataException("目标版本不在已注册清单");
        entries.Clear();
        foreach(var x in list.OrderBy(x=>x.Id,StringComparer.Ordinal)) entries.Add(x);
        TargetId=target;TargetMode=ver("target","mode");
        RollbackId=rollback;RollbackMode=ver("rollback","mode");
        ActualId=actual;ActualMode=GuiState.Value(snapshot,"actual","mode");
        ActualState=GuiState.Value(snapshot,"actual","state");
        Revision=GuiState.Value(snapshot,"configuration","revision");
        InstanceKey=GuiState.Value(snapshot,"instance","key");
        Fresh=true;lastError=null;
        Status=$"已从共享管理核心读取 {entries.Count} 个注册版本 · {DateTime.Now:HH:mm:ss}。安装文件完整性尚未由该 API 校验。";
        Notify("");
    }
    public void Invalidate(string message)
    {
        Fresh=false;lastError=message;
        Status="版本信息不可用，请重试读取；详情：" + (message.Length>120?message[..120]:message);
        Notify("");
    }
    public void Notify([CallerMemberName]string? name=null) =>
        PropertyChanged?.Invoke(this,new PropertyChangedEventArgs(name));
}

public sealed record PublishedRelease(string Tag, string Name, string Url, string Notes, bool Prerelease, DateTimeOffset PublishedAt)
{
    public string Category => Prerelease ? "预发布版本" : "正式版";
}
public static class B5ReleaseFeed
{
    private static readonly Uri Endpoint = new("https://api.github.com/repos/Venpenmen/Local-Desktop-Commander/releases?per_page=8");
    public static async Task<IReadOnlyList<PublishedRelease>> CheckAsync(CancellationToken cancel)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        using var req = new HttpRequestMessage(HttpMethod.Get,Endpoint);
        req.Headers.UserAgent.ParseAdd("LocalDC-GUI/1.0 (release-check)");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var res = await client.SendAsync(req,HttpCompletionOption.ResponseHeadersRead,cancel);
        res.EnsureSuccessStatusCode();
        if(res.Content.Headers.ContentLength>1024*1024)throw new InvalidDataException("发行元数据过大");
        using var stream=await res.Content.ReadAsStreamAsync(cancel);
        using var memory=new MemoryStream();
        var chunk=new byte[8192];
        int read;
        while((read=await stream.ReadAsync(chunk,cancel))!=0)
        {
            if(memory.Length+read>1024*1024)throw new InvalidDataException("发行元数据超过限制");
            memory.Write(chunk,0,read);
        }
        memory.Position=0;
        using var doc=await JsonDocument.ParseAsync(memory,cancellationToken:cancel);
        if(doc.RootElement.ValueKind!=JsonValueKind.Array)throw new InvalidDataException("发行列表格式错误");
        var results=new List<PublishedRelease>();
        foreach(var item in doc.RootElement.EnumerateArray().Take(8))
        {
            var tag=GuiState.Value(item,"tag_name");
            var url=GuiState.Value(item,"html_url");
            if(string.IsNullOrEmpty(tag) || tag.Length>48 ||
               !Uri.TryCreate(url,UriKind.Absolute,out var parsed) ||
               parsed.Scheme!="https" || parsed.Host!="github.com" ||
               !parsed.AbsolutePath.StartsWith("/Venpenmen/Local-Desktop-Commander/releases/",StringComparison.OrdinalIgnoreCase))
                continue;
            var prerelease=GuiState.Value(item,"prerelease")=="True";
            var published=DateTimeOffset.TryParse(GuiState.Value(item,"published_at"),out var time)?time:DateTimeOffset.MinValue;
            var notes=GuiState.Value(item,"body") ?? "";
            if(notes.Length>1200)notes=notes[..1200]+"…";
            results.Add(new(tag,(GuiState.Value(item,"name")??tag)[..Math.Min((GuiState.Value(item,"name")??tag).Length,100)],
                parsed.AbsoluteUri,notes,prerelease,published));
        }
        return results;
    }
    public static int CompareTags(string left,string right)
    {
        static (int[] Parts, string? Pre)? Parse(string tag)
        {
            if(tag.StartsWith('v'))tag=tag[1..];
            var match=System.Text.RegularExpressions.Regex.Match(tag,
                @"^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([A-Za-z0-9.-]{1,32}))?(?:\+[A-Za-z0-9.-]{1,32})?$");
            if(!match.Success)return null;
            return (new[]{int.Parse(match.Groups[1].Value),int.Parse(match.Groups[2].Value),
                int.Parse(match.Groups[3].Value)},match.Groups[4].Success?match.Groups[4].Value:null);
        }
        var a=Parse(left);var b=Parse(right);
        if(a is null || b is null)throw new ArgumentException("发行版本号格式不可比较");
        for(var i=0;i<3;i++)if(a.Value.Parts[i]!=b.Value.Parts[i])
            return a.Value.Parts[i].CompareTo(b.Value.Parts[i]);
        var x=a.Value.Pre;var y=b.Value.Pre;
        if(x==y)return 0;
        if(x is null)return 1; // stable releases outrank their prereleases
        if(y is null)return -1;
        var xs=x.Split('.');var ys=y.Split('.');
        for(int i=0;i<Math.Min(xs.Length,ys.Length);i++)
        {
            bool xn=ulong.TryParse(xs[i],out var xv);
            bool yn=ulong.TryParse(ys[i],out var yv);
            int diff=xn && yn ? xv.CompareTo(yv) : xn ? -1 : yn ? 1 :
                StringComparer.Ordinal.Compare(xs[i],ys[i]);
            if(diff!=0)return diff;
        }
        return xs.Length.CompareTo(ys.Length);
    }
}
