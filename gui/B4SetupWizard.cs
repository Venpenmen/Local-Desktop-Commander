using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;

namespace LocalDC.Gui;

/// <summary>Non-mutating wizard; only the owner's existing revision-safe Save performs changes.</summary>
public sealed class B4SetupWizard : Window
{
    private readonly GuiState state;
    private readonly TextBlock heading = new() { FontSize = 20, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock explanation = new() { TextWrapping = TextWrapping.Wrap, FontSize = 13 };
    private readonly StackPanel fields = new() { Margin = new Thickness(0, 15, 0, 0) };
    private readonly Button previous = new() { Content = "上一步", MinWidth = 75, MinHeight = 36 };
    private readonly Button next = new() { Content = "下一步", MinWidth = 75, MinHeight = 36 };
    private readonly Button cancel = new() { Content = "取消", MinWidth = 75, MinHeight = 36 };
    public int Step { get; private set; }
    public string SelectedMode { get; private set; }
    public string SelectedAccess { get; private set; }
    public string SelectedRoot { get; private set; }
    public bool LaunchAfter { get; private set; }

    private readonly string[] steps = [
        "环境检测", "工具模式", "文件权限", "连接配置",
        "配置汇总", "保存与连接验证"
    ];
    public B4SetupWizard(GuiState model)
    {
        state = model;
        SelectedMode = state.Get("configuration", "target", "mode") ?? "files";
        SelectedAccess = state.Get("fileAccess", "target", "mode") ?? "restricted";
        SelectedRoot = state.Get("fileAccess", "target", "allowedRoot") ?? "";
        Title = "Local DC · 首次使用引导";
        Width = 610; Height = 485; MinWidth = 520; MinHeight = 440;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;
        Background = (Brush)Application.Current.Resources["PageBackground"];
        Foreground = (Brush)Application.Current.Resources["TextPrimary"];
        FontFamily = new FontFamily("Microsoft YaHei UI");
        FontSize = 14;
        var layout = new DockPanel { Margin = new Thickness(21) };
        Content = layout;
        var footer = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        DockPanel.SetDock(footer, Dock.Bottom);
        layout.Children.Add(footer);
        previous.Click += (_, _) => { if (Step > 0) { Step--; Draw(); } };
        next.Click += (_, _) =>
        {
            if (!ValidateStep()) return;
            if (Step < steps.Length - 1) { Step++; Draw(); }
            else { DialogResult = true; Close(); }
        };
        cancel.Click += (_, _) => { DialogResult = false; Close(); };
        footer.Children.Add(cancel);
        footer.Children.Add(previous);
        footer.Children.Add(next);
        foreach (var button in new[] { previous, next, cancel })
            button.Margin = new Thickness(8, 0, 0, 0);
        var content = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        layout.Children.Add(content);
        var column = new StackPanel { Margin = new Thickness(5, 2, 5, 15) };
        content.Content = column;
        column.Children.Add(heading);
        explanation.Margin = new Thickness(0, 8, 0, 10);
        explanation.Foreground = (Brush)Application.Current.Resources["TextSecondary"];
        column.Children.Add(explanation);
        var card = new Border
        {
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(14),
            BorderThickness = new Thickness(1),
            Background = (Brush)Application.Current.Resources["Surface"],
            BorderBrush = (Brush)Application.Current.Resources["Border"],
            Child = fields
        };
        column.Children.Add(card);
        Draw();
    }
    private TextBlock Note(string label)
    {
        var text = new TextBlock
        {
            Text = label, TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 11)
        };
        fields.Children.Add(text);
        return text;
    }
    private ComboBox Picker(string selected, params (string Key, string Name)[] items)
    {
        var box = new ComboBox { Width = 365, HorizontalAlignment = HorizontalAlignment.Left, MinHeight = 35 };
        foreach (var item in items)
            box.Items.Add(new ComboBoxItem { Tag = item.Key, Content = item.Name });
        box.SelectedValuePath = "Tag";
        box.SelectedValue = selected;
        fields.Children.Add(box);
        return box;
    }
    private void Draw()
    {
        heading.Text = $"第 {Step + 1}/6 步 · {steps[Step]}";
        previous.IsEnabled = Step > 0;
        next.Content = Step == 5 ? "完成并应用" : "下一步";
        fields.Children.Clear();
        switch (Step)
        {
            case 0:
                explanation.Text = "确认此窗口管理的实例身份和当前运行情况。";
                Note("实例：" + (state.Get("instance", "id") ?? "未知"));
                Note("传输类型：" + (state.Get("instance", "transport") ?? "未知"));
                Note("当前运行状态：" + state.ActualState);
                Note("向导不修改实例，直到最后一步确认并调用既有管理接口。");
                break;
            case 1:
                explanation.Text = "选择要在下一次运行时启用的 MCP 工具模式。";
                var mode = Picker(SelectedMode, ("files", "文件模式 · 14 项工具"),
                    ("terminal", "完整终端模式 · 21 项工具"));
                mode.SelectionChanged += (_, _) =>
                    SelectedMode = mode.SelectedValue as string ?? SelectedMode;
                Note("完整终端模式使用 Windows 用户的实际系统权限。");
                break;
            case 2:
                explanation.Text = "配置文件工具访问权限及受限授权目录。";
                var choice = Picker(SelectedAccess, ("restricted", "Restricted · 受限访问"),
                    ("full", "Full · 完整文件访问"));
                if (!state.FullAvailable)
                    ((ComboBoxItem)choice.Items[1]).IsEnabled = false;
                choice.SelectionChanged += (_, _) =>
                    SelectedAccess = choice.SelectedValue as string ?? SelectedAccess;
                var row = new DockPanel { Margin = new Thickness(0, 12, 0, 9) };
                var browse = new Button { Content = "浏览…", MinWidth = 85, Margin = new Thickness(8, 0, 0, 0) };
                DockPanel.SetDock(browse, Dock.Right);
                row.Children.Add(browse);
                var path = new TextBox { Text = SelectedRoot, MinHeight = 35 };
                path.TextChanged += (_, _) => SelectedRoot = path.Text;
                row.Children.Add(path);
                browse.Click += (_, _) =>
                {
                    var dialog = new OpenFolderDialog();
                    if (Directory.Exists(path.Text)) dialog.InitialDirectory = path.Text;
                    if (dialog.ShowDialog(this) == true) path.Text = dialog.FolderName;
                };
                fields.Children.Add(row);
                Note("受限目录必须是现有本地目录；Full 仅在允许的托管实例开放。");
                break;
            case 3:
                explanation.Text = "查看当前实例适用的托管连接能力。";
                Note(state.ProxyStatus);
                Note(state.CredentialStatus);
                Note(state.CanManageHosted
                    ? "代理与 DPAPI 凭据可在主窗口运行设置中独立配置。凭据通过专用安全交互入口输入。"
                    : "本地开发实例仅使用回环连接，不需要托管代理或密钥。");
                break;
            case 4:
                explanation.Text = "核对即将保存的目标配置；原有 Revision 和操作锁仍将校验。";
                Note($"工具：{SelectedMode}");
                Note($"文件权限：{SelectedAccess}");
                Note($"授权目录：{SelectedRoot}");
                var start = new CheckBox { Content = "应用后启动服务（可选）", IsChecked = LaunchAfter,
                    Margin = new Thickness(0, 0, 0, 12) };
                start.Checked += (_, _) => LaunchAfter = true;
                start.Unchecked += (_, _) => LaunchAfter = false;
                fields.Children.Add(start);
                Note("如果实例正在运行且配置发生变化，将按原有确认与停机流程保存。");
                break;
            default:
                explanation.Text = "完成后回到 GUI，使用原有保存逻辑写入目标配置并执行连接检查。";
                Note("配置变更仍需要最终确认，不会在向导中绕过管理协议。");
                Note("服务启动、MCP 实际发现、远程客户端验证是彼此独立的阶段。");
                Note("网络代理及凭据由运行设置中的相应入口分别管理。");
                break;
        }
    }
    private bool ValidateStep()
    {
        if (Step == 2 && (!Directory.Exists(SelectedRoot) ||
            (SelectedAccess == "full" && !state.FullAvailable)))
        {
            MessageBox.Show(this, "授权根目录必须存在，且此实例必须支持所选权限。",
                "配置检查", MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }
        return true;
    }
}
