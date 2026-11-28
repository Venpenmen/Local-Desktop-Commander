using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace LocalDC.Gui;

/// <summary>Read-only local MCP discovery. The child is owned by the GUI and never controls the service.</summary>
public sealed class McpDiagnostics(string root)
{
    private readonly string rootPath = Path.GetFullPath(root);
    public async Task<JsonElement> InspectAsync(JsonElement state, TimeSpan? timeout = null)
    {
        var instance = GuiState.Value(state, "instance", "id");
        var transport = GuiState.Value(state, "instance", "transport");
        var mode = GuiState.Value(state, "actual", "mode");
        var status = GuiState.Value(state, "actual", "state");
        var pidText = GuiState.Value(state, "actual", "pid");
        if (instance != "gui" || transport != "local-dev")
            throw new NotSupportedException("此实例没有受支持的本地 MCP 检测入口；远程客户端状态保持未验证。");
        if (status != "running" || !int.TryParse(pidText, out var pid) || pid <= 0 ||
            mode is not ("files" or "terminal"))
            throw new InvalidOperationException("本地实例未运行，当前无法实际发现工具。");

        var packaged = Path.Combine(AppContext.BaseDirectory, "diagnostics", "mcp-inspect.mjs");
        var inspector = File.Exists(packaged) ? packaged : Path.Combine(rootPath, "gui", "mcp-inspect.mjs");
        if (!File.Exists(inspector)) throw new FileNotFoundException("缺少本地 MCP 检测组件", inspector);
        var start = new ProcessStartInfo("node.exe")
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
        start.ArgumentList.Add(inspector);
        using var child = Process.Start(start) ?? throw new IOException("无法启动本地 MCP 检测程序");
        var stdout = child.StandardOutput.ReadToEndAsync();
        var stderr = child.StandardError.ReadToEndAsync();
        var request = JsonSerializer.Serialize(new
        {
            schema = 1,
            instance,
            transport,
            mode,
            pid,
            state = status
        });
        await child.StandardInput.WriteLineAsync(request);
        child.StandardInput.Close();

        using var deadline = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(20));
        try { await child.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            if (!child.HasExited)
            {
                try { child.Kill(entireProcessTree: true); } catch { }
            }
            throw new TimeoutException("本地 MCP 发现超时；仅取消检测进程，不影响 LDC 服务。");
        }
        var output = await stdout;
        _ = await stderr;
        if (output.Length == 0 || output.Length > 131072 || child.ExitCode != 0)
            throw new IOException("MCP 检测程序无有效响应");
        using var doc = JsonDocument.Parse(output);
        if (!doc.RootElement.TryGetProperty("schema", out var schema) || schema.GetInt32() != 1)
            throw new IOException("MCP 检测响应格式不正确");
        return doc.RootElement.Clone();
    }
}
