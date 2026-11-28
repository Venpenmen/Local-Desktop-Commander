using System.Collections.ObjectModel;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LocalDC.Gui;

public sealed record LogRow(string Key, string When, string Level, string Source, string Message)
{
    public string Display => $"{When}  {Level,-5}  {Message}";
}
/// <summary>Presentation cache of the existing bounded, redacted management logs API.</summary>
public sealed class B4LogCenter : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;
    private readonly List<LogRow> history = [];
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private string source = "全部";
    private string level = "全部";
    private string search = "";
    private string status = "尚未读取日志";
    private bool follow = true;
    public ObservableCollection<LogRow> Rows { get; } = [];
    public string Source { get => source; set { source = value ?? "全部"; Filter(); } }
    public string Level { get => level; set { level = value ?? "全部"; Filter(); } }
    public string Search { get => search; set { search = value ?? ""; Filter(); } }
    public string Status { get => status; set { status = value; Notify(); } }
    public bool Follow { get => follow; set { follow = value; Notify(); } }
    public int Count => history.Count;
    public bool HasNoMatches => Rows.Count == 0;
    public string ExportText => string.Join(Environment.NewLine, Rows.Select(r =>
        $"{r.When} [{r.Source}/{r.Level}] {r.Message}"));
    public void Notify([CallerMemberName] string? property = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(property));

    private static readonly Regex Sensitive = new(
        @"(?i)\b(?:authorization|bearer|api[_ -]?key|credential|secret|password|token)\b\s*(?::|=|\s)\s*[^\s,;]+|sk-[a-z0-9_-]{10,}",
        RegexOptions.Compiled, TimeSpan.FromMilliseconds(100));
    private static readonly Regex LocalPath = new(
        @"(?i)\b[A-Z]:\\[^\s,;\r\n]+", RegexOptions.Compiled, TimeSpan.FromMilliseconds(100));
    private static readonly Regex UrlQuery = new(
        @"(?i)(https?://[^\s?]+)\?[^\s]+", RegexOptions.Compiled, TimeSpan.FromMilliseconds(100));
    public static string Redact(string? value)
    {
        var text = new string((value ?? "").Where(c => c >= ' ' || c == '\t').Take(1600).ToArray());
        try
        {
            text = Sensitive.Replace(text, "[凭据信息已隐藏]");
            text = LocalPath.Replace(text, "[本机路径]");
            text = UrlQuery.Replace(text, "$1?[参数已隐藏]");
        }
        catch (RegexMatchTimeoutException) { return "[日志内容已隐藏]"; }
        return text.Length > 480 ? text[..480] + "…" : text;
    }
    private static string FormatDate(string? value)
    {
        if (DateTimeOffset.TryParse(value, out var time))
            return time.ToLocalTime().ToString("MM-dd HH:mm:ss");
        return "时间未知";
    }
    private void Add(LogRow row)
    {
        if (!seen.Add(row.Key)) return;
        history.Add(row);
        if (history.Count > 200)
        {
            var remove = history[0];
            history.RemoveAt(0);
            seen.Remove(remove.Key);
        }
    }
    public void Apply(JsonElement result)
    {
        if (result.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("日志接口未返回对象");
        if (result.TryGetProperty("tunnel", out var tunnel) && tunnel.ValueKind == JsonValueKind.Array)
            foreach (var x in tunnel.EnumerateArray())
            {
                if (x.ValueKind != JsonValueKind.String) continue;
                var original = x.GetString() ?? "";
                if (string.IsNullOrWhiteSpace(original)) continue;
                var bits = original.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
                var when = bits.Length > 0 ? FormatDate(bits[0]) : "时间未知";
                var level = bits.Length > 1 && bits[1].ToUpperInvariant() is "ERROR" or "WARN" or "DEBUG" or "INFO"
                    ? bits[1].ToUpperInvariant() : "INFO";
                var message = Redact(bits.Length == 3 ? bits[2] : original);
                Add(new LogRow("t:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(original))), when, level, "服务日志", message));
            }
        if (result.TryGetProperty("events", out var events) && events.ValueKind == JsonValueKind.Array)
            foreach (var x in events.EnumerateArray())
            {
                if (x.ValueKind != JsonValueKind.Object) continue;
                var utc = GuiState.Value(x, "utc") ?? "";
                var kind = GuiState.Value(x, "kind") ?? "event";
                var version = GuiState.Value(x, "version") ?? "—";
                var mode = GuiState.Value(x, "mode") ?? "—";
                var code = GuiState.Value(x, "code") ?? "0";
                var level = code != "0" ? "ERROR" : "INFO";
                var message = Redact($"{kind} · {version}/{mode} · exit {code}");
                Add(new LogRow("e:" + utc + ":" + kind + ":" + version + ":" + mode + ":" + code,
                    FormatDate(utc), level, "管理事件", message));
            }
        Filter();
        Status = $"已缓存 {history.Count}/200 项 · 最近读取 {DateTime.Now:HH:mm:ss}（来源：有界管理 API）";
    }
    private void Filter()
    {
        Rows.Clear();
        foreach (var row in history.AsEnumerable().Reverse())
        {
            if (Source != "全部" && row.Source != Source) continue;
            if (Level != "全部" && row.Level != Level) continue;
            if (Search.Trim().Length != 0 &&
                !($"{row.When} {row.Level} {row.Source} {row.Message}")
                .Contains(Search.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
            Rows.Add(row);
        }
        Notify(nameof(Rows));
        Notify(nameof(ExportText));
        Notify(nameof(Count));
        Notify(nameof(HasNoMatches));
    }
}

public static class B4Proxy
{
    public static bool TryNormalize(string? input, out string? normalized)
    {
        normalized = null;
        var value = input?.Trim() ?? "";
        if (string.IsNullOrEmpty(value) || value.Equals("AUTO", StringComparison.OrdinalIgnoreCase))
            return true;
        if (value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) value = value[7..];
        if (value.EndsWith('/')) value = value[..^1];
        var match = Regex.Match(value, @"^(?:127\.0\.0\.1|localhost):([0-9]{1,5})$", RegexOptions.IgnoreCase,
            TimeSpan.FromMilliseconds(100));
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var port) ||
            port is < 1 or > 65535) return false;
        normalized = $"http://127.0.0.1:{port}";
        return true;
    }
    public static bool IsHosted(string? transport) => transport == "openai";
}
