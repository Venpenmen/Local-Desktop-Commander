using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace LocalDC.Gui;

/// <summary>A management request is exactly one PowerShell child and one JSON line.</summary>
public sealed class ManagementClient(string root)
{
    private string? instanceKey;
    private readonly string rootPath = Path.GetFullPath(root);

    public string? InstanceKey => instanceKey;

    public async Task<JsonElement> RequestAsync(string operation, object? arguments = null, TimeSpan? timeout = null)
    {
        var id = Guid.NewGuid().ToString("N");
        var script = Path.Combine(rootPath, "management", "LDC-CLI.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("目标工作区缺少管理接口", script);
        if (instanceKey is null && operation != "state")
            throw new InvalidOperationException("请先通过 state 绑定实例身份");

        var info = new ProcessStartInfo(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            WorkingDirectory = rootPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var arg in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
                     "Bypass", "-File", script })
            info.ArgumentList.Add(arg);

        using var process = Process.Start(info) ?? throw new IOException("管理 CLI 子进程启动失败");
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        var request = new Dictionary<string, object?>
        {
            ["protocol"] = 1, ["id"] = id, ["operation"] = operation,
            ["arguments"] = arguments
        };
        if (instanceKey is not null) request["instance"] = instanceKey;
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request));
        process.StandardInput.Close();

        using var timer = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(90));
        try { await process.WaitForExitAsync(timer.Token); }
        catch (OperationCanceledException)
        {
            // The operation might still be running. Do NOT repeat the mutation.
            throw new TimeoutException("管理调用超时，操作结果未知。请先刷新实际状态，不要重复提交。");
        }
        var raw = await output;
        _ = await errors; // stderr is deliberately never rendered; it may contain private paths.
        if (string.IsNullOrWhiteSpace(raw))
            throw new IOException("管理接口未返回 JSON，请核实目标工作区和运行环境");

        JsonDocument doc;
        try { doc = JsonDocument.Parse(raw); }
        catch (JsonException) { throw new IOException("管理接口输出不符合单行 JSON 协议"); }
        using (doc)
        {
            var reply = doc.RootElement;
            if (reply.GetProperty("protocol").GetInt32() != 1 ||
                reply.GetProperty("id").GetString() != id)
                throw new IOException("协议版本或请求 ID 不匹配");
            var key = reply.TryGetProperty("instance", out var k) ? k.GetString() : null;
            if (key is not null && instanceKey is not null && key != instanceKey)
                throw new IOException("INSTANCE_MISMATCH：目标实例身份不一致");
            if (!reply.GetProperty("ok").GetBoolean())
            {
                var error = reply.GetProperty("error");
                var code = error.GetProperty("code").GetString();
                var msg = error.TryGetProperty("message", out var m) ? m.GetString() : "操作失败";
                throw new InvalidOperationException(code + "：" + msg);
            }
            if (operation == "state")
            {
                var stateKey = reply.GetProperty("result").GetProperty("instance").GetProperty("key").GetString();
                if (string.IsNullOrWhiteSpace(stateKey) || key != stateKey)
                    throw new IOException("状态响应缺少可信实例身份");
                if (instanceKey is not null && stateKey != instanceKey)
                    throw new IOException("INSTANCE_MISMATCH：禁止跨实例切换");
                instanceKey = stateKey;
            }
            return reply.GetProperty("result").Clone();
        }
    }
}
