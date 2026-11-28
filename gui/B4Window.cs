using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;

namespace LocalDC.Gui;

public partial class MainWindow
{
    private readonly B4LogCenter logCenter = new();
    private readonly SemaphoreSlim logGate = new(1, 1);
    private string? networkRevision;
    private string workspaceRoot = "";

    private void InitializeB4()
    {
        LogPanel.DataContext = logCenter;
        Pages.SelectionChanged += async (sender, args) =>
        {
            if (args.Source == Pages && Pages.SelectedIndex == 3)
                await FetchLogsAsync();
        };
        ProxyMode.SelectedValue = "auto";
        ProxyAddress.IsEnabled = false;
    }
    private void LoadNetworkForm()
    {
        networkRevision = vm.Get("configuration", "revision");
        var proxy = vm.Get("configuration", "proxy");
        ProxyMode.SelectedValue = proxy is null ? "auto" : "manual";
        ProxyAddress.Text = proxy ?? "";
        ProxyAddress.IsEnabled = vm.CanManageHosted &&
            (ProxyMode.SelectedValue as string) == "manual";
    }
    private void ProxyMode_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (ProxyAddress is not null && ProxyMode is not null)
            ProxyAddress.IsEnabled = vm.CanManageHosted &&
                (ProxyMode.SelectedValue as string) == "manual";
    }
    private async Task FetchLogsAsync()
    {
        if (closing || !vm.Fresh || vm.Busy || !logGate.Wait(0)) return;
        try
        {
            var result = await client.RequestAsync("logs", timeout: TimeSpan.FromSeconds(18));
            if (!closing) logCenter.Apply(result);
        }
        catch (Exception)
        {
            logCenter.Status = "日志读取失败。请检查实例状态或使用管理控制台。";
        }
        finally { logGate.Release(); }
    }
    private void LogFilter_Changed(object sender, SelectionChangedEventArgs e)
    {
        if (LogSource?.SelectedItem is ComboBoxItem src)
            logCenter.Source = src.Content?.ToString() ?? "全部";
        if (LogLevel?.SelectedItem is ComboBoxItem lvl)
            logCenter.Level = lvl.Content?.ToString() ?? "全部";
    }
    private void LogQuery_Changed(object sender, TextChangedEventArgs e)
    {
        if (LogQuery is not null) logCenter.Search = LogQuery.Text;
    }
    private async void LogRefresh_Click(object sender, RoutedEventArgs e) => await FetchLogsAsync();
    private void OpenLogs_Click(object sender, RoutedEventArgs e) => Pages.SelectedIndex = 3;
    private void LogCopy_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Clipboard.SetText(logCenter.ExportText);
            logCenter.Status = $"已复制 {logCenter.Rows.Count} 条经过脱敏的日志。";
        }
        catch { logCenter.Status = "剪贴板不可用，请使用脱敏导出。"; }
    }
    private void LogExport_Click(object sender, RoutedEventArgs e)
    {
        if (logCenter.Rows.Count == 0) { logCenter.Status = "没有可导出的日志。"; return; }
        var picker = new SaveFileDialog
        {
            Title = "导出脱敏日志", FileName = "LocalDC-logs-redacted.txt",
            Filter = "文本文件 (*.txt)|*.txt", AddExtension = true,
            OverwritePrompt = true
        };
        if (picker.ShowDialog(this) != true) return;
        try
        {
            // No raw runtime files, credentials or unredacted entries ever leave this view.
            File.WriteAllText(picker.FileName, logCenter.ExportText, new UTF8Encoding(false));
            logCenter.Status = $"已导出 {logCenter.Rows.Count} 条脱敏日志。";
        }
        catch { logCenter.Status = "日志导出失败，请检查目标文件权限。"; }
    }
    private async void ProxyTest_Click(object sender, RoutedEventArgs e)
    {
        if (!vm.CanManageHosted) { vm.Message = "当前实例不支持公网代理诊断。"; return; }
        var checkedResult = false;
        var reachable = false;
        await Run(async () =>
        {
            var result = await client.RequestAsync("diagnose", timeout: TimeSpan.FromSeconds(50));
            reachable = GuiState.Value(result, "reachable") == "True";
            checkedResult = true;
        });
        if (checkedResult)
            vm.Message = reachable
                ? "OpenAI HTTPS 路径可达。公网鉴权及远程 MCP 客户端调用仍未验证。"
                : "OpenAI HTTPS 预检失败；请检查本地代理或直连。";
    }
    private async void ProxySave_Click(object sender, RoutedEventArgs e)
    {
        if (!vm.CanManageHosted) { vm.Message = "当前实例不支持代理配置。"; return; }
        var manual = (ProxyMode.SelectedValue as string) == "manual";
        if (!B4Proxy.TryNormalize(manual ? ProxyAddress.Text : null, out var candidate) ||
            (manual && candidate is null))
        {
            vm.Message = "INVALID_ARGUMENT：只接受 127.0.0.1 或 localhost 的 HTTP 代理端口 1～65535。";
            return;
        }
        if (candidate == vm.Get("configuration", "proxy"))
        {
            vm.Message = "当前代理目标未变化。"; return;
        }
        if (!Confirm("确认修改此实例的代理目标？\n运行中的服务不会自动重启；需要手动重启后再核验实际连接。"))
            return;
        var completed = false;
        await Run(async () =>
        {
            await Read();
            if (!vm.CanManageHosted || networkRevision != vm.Get("configuration", "revision"))
                throw new InvalidOperationException("REVISION_CONFLICT：请先重新读取当前配置");
            if (vm.Get("actual", "state") is "unsafe" or "starting")
                throw new InvalidOperationException("当前实例状态不允许修改网络配置");
            await Mutate("network.set", new
            {
                confirmed = true, revision = networkRevision, proxy = candidate
            });
            completed = true;
            await Read();
            LoadNetworkForm();
        });
        if (completed)
            vm.Message = "代理目标已保存；运行中的代理使用状态未知，请手动重启并重新诊断。";
    }
    private async void CredentialConfigure_Click(object sender, RoutedEventArgs e)
        => await OpenCredentialConsoleAsync("Configure");
    private async void CredentialForget_Click(object sender, RoutedEventArgs e)
        => await OpenCredentialConsoleAsync("Forget");
    private async Task OpenCredentialConsoleAsync(string operation)
    {
        if (!vm.CanManageHosted || operation is not ("Configure" or "Forget"))
        {
            vm.Message = "当前实例不适用托管凭据操作。"; return;
        }
        if (!Confirm(operation == "Forget"
            ? "清除当前实例已保存的 DPAPI 凭据？这会影响下一次隧道鉴权。控制台中仍需再次确认。"
            : "将在独立 PowerShell 交互窗口中安全输入凭据（隐藏输入）。确认打开？"))
            return;
        var script = Path.Combine(workspaceRoot, "management", "LDC-Stable.ps1");
        if (!File.Exists(script)) { vm.Message = "找不到现有安全凭据入口。"; return; }
        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            WorkingDirectory = workspaceRoot,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Normal
        };
        foreach (var argument in new[] { "-NoLogo", "-NoProfile", "-ExecutionPolicy",
                                          "Bypass", "-NoExit", "-File", script, "-Action", operation })
            info.ArgumentList.Add(argument);
        try
        {
            using var process = Process.Start(info);
            if (process is null) throw new InvalidOperationException();
            vm.Message = "凭据操作窗口已打开。输入过程由现有 DPAPI 脚本管理，完成后返回 GUI 点击刷新。";
            // -NoExit deliberately lets the user read the final prompt, not an unattended process.
        }
        catch { vm.Message = "无法启动现有凭据交互窗口。"; }
        await Refresh(false);
    }
    private async void Wizard_Click(object sender, RoutedEventArgs e)
    {
        if (!vm.CanOperate) return;
        var wizard = new B4SetupWizard(vm) { Owner = this };
        if (wizard.ShowDialog() != true) return;
        ToolMode.SelectedValue = wizard.SelectedMode;
        AccessMode.SelectedValue = wizard.SelectedAccess;
        RootPath.Text = wizard.SelectedRoot;
        await Save(wizard.LaunchAfter);
        if (vm.Message.StartsWith("管理操作已完成", StringComparison.Ordinal) ||
            vm.Message == "当前配置没有变化。")
        {
            Pages.SelectedIndex = 1;
            await Inspect(true);
        }
    }
}
