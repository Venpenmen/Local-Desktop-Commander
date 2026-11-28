using System.IO;
using System.Windows;
using System.Windows.Threading;
using System.Text.Json;
using Microsoft.Win32;

namespace LocalDC.Gui;

public partial class MainWindow : Window
{
    private readonly GuiState vm = new();
    private readonly ManagementClient client;
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(3) };
    private readonly SemaphoreSlim gate = new(1, 1);
    private bool closing;
    private string? formRevision;
    // Replaced only by in-process integration tests; production uses the normal dialog.
    internal Func<string,bool>? ConfirmationForTests { get; set; }

    public MainWindow()
    {
        InitializeComponent();
        DataContext = vm;
        var args = Environment.GetCommandLineArgs();
        var rootArg = Array.IndexOf(args, "--root");
        DirectoryInfo? dir;
        if (rootArg >= 0)
        {
            if (rootArg == args.Length - 1) throw new ArgumentException("--root 需要完整工作区路径");
            dir = new DirectoryInfo(Path.GetFullPath(args[rootArg + 1]));
        }
        else
        {
            dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "management", "LDC-CLI.ps1")))
                dir = dir.Parent;
        }
        if (dir is null || !File.Exists(Path.Combine(dir.FullName, "management", "LDC-CLI.ps1")))
            throw new InvalidOperationException("找不到目标工作区管理接口。独立包请使用 --root <工作区路径>。");
        client = new ManagementClient(dir.FullName);

        Loaded += async (_, _) => { await Refresh(true); timer.Start(); };
        timer.Tick += async (_, _) => await Refresh(false);
        Closed += (_, _) => { closing = true; timer.Stop(); };
    }

    private async Task Read()
    {
        var snapshot = await client.RequestAsync("state");
        if (!closing) vm.Apply(snapshot);
    }
    private void LoadForm()
    {
        ToolMode.SelectedValue = vm.Get("configuration", "target", "mode");
        AccessMode.SelectedValue = vm.Get("fileAccess", "target", "mode");
        RootPath.Text = vm.Get("fileAccess", "target", "allowedRoot") ?? "";
        formRevision = vm.Get("configuration", "revision");
    }
    private async Task Refresh(bool load)
    {
        if (closing || !gate.Wait(0)) return;
        try
        {
            await Read();
            if (load) LoadForm();
            if (vm.Message == "正在读取实例…") vm.Message = "实例状态已更新。";
        }
        catch (Exception e) { vm.Invalidate(); vm.Message = e.Message; }
        finally { gate.Release(); }
    }
    private bool Confirm(string message) => ConfirmationForTests?.Invoke(message) ??
        MessageBox.Show(this, message, "确认操作", MessageBoxButton.YesNo, MessageBoxImage.Warning) == MessageBoxResult.Yes;

    private async Task Mutate(string op, object arguments)
    {
        var task = await client.RequestAsync(op, arguments);
        var state = GuiState.Value(task, "state");
        if (state != "completed")
            throw new InvalidOperationException("操作未成功完成：" + (state ?? "未知"));
    }
    private async Task Run(Func<Task> action)
    {
        if (closing || vm.Busy) return;
        vm.Busy = true;
        await gate.WaitAsync();
        vm.Message = "正在执行，请勿重复操作…";
        bool failed = false;
        try
        {
            await action();
            vm.Message = "管理操作已完成；服务是否就绪请以实际状态为准。";
        }
        catch (Exception e)
        {
            failed = true;
            vm.Message = e.Message + "。已重新读取实际状态，请检查后再操作。";
        }
        finally
        {
            try
            {
                await Read();
                if (failed) LoadForm(); // never keep an editable stale revision after partial success
            }
            catch (Exception e)
            {
                vm.Invalidate();
                vm.Message += " 状态读取失败：" + e.Message;
            }
            vm.Busy = false;
            gate.Release();
        }
    }
    private async Task Service(string operation)
    {
        if (!vm.CanOperate) return;
        var approved = Confirm("确认对当前开发实例执行 " + operation + "？");
        if (!approved) return;
        await Run(() => Mutate(operation, new { confirmed = true }));
    }
    private async void Start_Click(object sender, RoutedEventArgs e) => await Service("start");
    private async void Stop_Click(object sender, RoutedEventArgs e) => await Service("stop");
    private async void Restart_Click(object sender, RoutedEventArgs e) => await Service("restart");
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await Refresh(false);
    private async void Load_Click(object sender, RoutedEventArgs e) => await Refresh(true);

    private void Browse_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog();
        if (Directory.Exists(RootPath.Text)) dialog.InitialDirectory = RootPath.Text;
        if (dialog.ShowDialog(this) == true) RootPath.Text = dialog.FolderName;
    }
    private async void Save_Click(object sender, RoutedEventArgs e) => await Save(false);
    private async void SaveStart_Click(object sender, RoutedEventArgs e) => await Save(true);

    private async Task Save(bool start)
    {
        if (!vm.CanOperate) return;
        var tool = ToolMode.SelectedValue as string;
        var access = AccessMode.SelectedValue as string;
        var root = RootPath.Text.Trim();
        if (tool is not ("files" or "terminal") || access is not ("restricted" or "full") || root.Length == 0)
        {
            vm.Message = "请选择完整配置。"; return;
        }
        if (!vm.FullAvailable && access == "full")
        {
            vm.Message = "当前本地开发实例禁止开启 Full。"; return;
        }
        if (!Directory.Exists(root))
        {
            vm.Message = "INVALID_ROOT：授权根必须是现有本地目录。"; return;
        }
        var changed = tool != vm.Get("configuration", "target", "mode") ||
                      access != vm.Get("fileAccess", "target", "mode") ||
                      root != vm.Get("fileAccess", "target", "allowedRoot");
        if (!changed && !start) { vm.Message = "当前配置没有变化。"; return; }
        var warning = "确认保存配置？" +
            (changed ? "如果实例正在运行，将先停止并保存。" : "") +
            (start ? "保存后启动实例。" : "完成后保持停止状态。") +
            (tool == "terminal" ? "\n完整终端模式使用当前 Windows 用户权限。" : "") +
            (access == "full" ? "\nFull 允许文件工具跨本机盘符访问，请确认此权限。" : "");
        if (!Confirm(warning)) return;

        await Run(async () =>
        {
            await Read();
            if (formRevision != vm.Get("configuration", "revision"))
                throw new InvalidOperationException("REVISION_CONFLICT：配置已被其他管理端修改，请重新读取");
            var version = vm.Get("configuration", "target", "version")
                ?? throw new InvalidOperationException("缺少当前目标版本");
            var actual = vm.Get("actual", "state");
            if (actual is "unsafe" or "starting")
                throw new InvalidOperationException("当前实际状态不允许修改，请先排查状态");
            if (changed && actual == "running")
            {
                await Mutate("stop", new { confirmed = true });
                await Read();
            }
            if (changed && vm.Get("actual", "state") != "stopped")
                throw new InvalidOperationException("实例尚未停止，拒绝配置修改");

            var revision = vm.Get("configuration", "revision");
            async Task Update(string operation, object arguments)
            {
                await Mutate(operation, arguments);
                await Read();
                revision = vm.Get("configuration", "revision");
            }
            if (root != vm.Get("fileAccess", "target", "allowedRoot"))
                await Update("root.set", new { confirmed = true, revision, version, path = root });
            if (access != vm.Get("fileAccess", "target", "mode"))
                await Update("access.set", new { confirmed = true, revision, version, mode = access });
            if (tool != vm.Get("configuration", "target", "mode"))
                await Update("select", new { confirmed = true, revision, version, mode = tool });
            if (start && vm.Get("actual", "state") == "stopped")
                await Mutate("start", new { confirmed = true });
            await Read();
            LoadForm();
        });
    }
}
