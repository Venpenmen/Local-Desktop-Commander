using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using LocalDC.Gui;

internal static class Program
{
    private static int failed;
    private static readonly List<string> Checks = [];
    private static readonly string Root = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..","..","..","..",".."));
    private static void Check(bool condition, string name)
    {
        if (!condition) throw new Exception("FAIL " + name);
        Checks.Add(name);
        Console.WriteLine("PASS " + name);
    }
    private static void Screenshot(FrameworkElement element, string name, double scale = 1)
    {
        var panel = element as Panel;
        var originalBackground = panel?.Background;
        if (panel is not null) panel.Background =
            Application.Current.Resources["PageBackground"] as Brush ??
            new SolidColorBrush(Color.FromRgb(244, 246, 248));
        element.LayoutTransform = new ScaleTransform(scale, scale);
        element.UpdateLayout();
        var size = new Size(element.ActualWidth * scale, element.ActualHeight * scale);
        var width = Math.Max(1, (int)Math.Ceiling(size.Width));
        var height = Math.Max(1, (int)Math.Ceiling(size.Height));
        var image = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        image.Render(element);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(image));
        using var file = File.Create(Path.Combine(Root,"test-runtime",name));
        encoder.Save(file);
        if (panel is not null) panel.Background = originalBackground;
        Check(file.Length > 6000, name + " rendered and persisted");
    }
    [STAThread]
    private static void Main(string[] args)
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.DispatcherUnhandledException += (_,e) =>
        { Console.Error.WriteLine(e.Exception); failed=1; e.Handled=true; app.Shutdown(); };
        app.Dispatcher.BeginInvoke(new Action(async () =>
        {
            MainWindow? window=null;
            ThemeChoice? savedTheme = null;
            try
            {
                window = new MainWindow
                {
                    Left = -32000, Top = -32000, ShowInTaskbar=false, ShowActivated=false,
                    WindowStartupLocation=WindowStartupLocation.Manual
                };
                savedTheme = ThemeManager.Choice;
                window.Show();
                await Task.Delay(400);
                var vm=(GuiState)typeof(MainWindow).GetField("vm",
                    System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!
                    .GetValue(window)!;
                for (var i=0;i<90 && !vm.Fresh;i++) await Task.Delay(400);
                Check(vm.Fresh && vm.InstanceLabel.Contains("gui"),
                    "live UI reads isolated GUI instance");
                if(args.Contains("--linger"))
                {
                    File.WriteAllText(Path.Combine(Root,"test-runtime","gui-crash-ready.txt"),
                        Environment.ProcessId.ToString());
                    await Task.Delay(Timeout.InfiniteTimeSpan);
                }
                Check(vm.Message != "正在读取实例…",
                    "initial successful refresh replaces loading message");
                var beforePoll=vm.Get("observedUtc");
                for(var i=0;i<45 && vm.Get("observedUtc")==beforePoll;i++)await Task.Delay(350);
                Check(vm.Get("observedUtc")!=beforePoll,
                    "automatic status polling refreshes timestamp");
                var manualBefore=vm.Get("observedUtc");
                typeof(MainWindow).GetMethod("Refresh_Click",
                    System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!
                    .Invoke(window,[window,new RoutedEventArgs(Button.ClickEvent)]);
                for(var i=0;i<45 && vm.Get("observedUtc")==manualBefore;i++)await Task.Delay(350);
                Check(vm.Get("observedUtc")!=manualBefore,
                    "manual refresh updates actual snapshot");
                Check(window.MinWidth <= 720 && window.MinHeight <= 520,
                    "minimum window dimensions");
                var layout=(DockPanel)window.Content;
                var tabs=layout.Children.OfType<TabControl>().Single();
                Check(tabs.Items.Count==5,"five-page overview connection tools logs settings navigation");
                var themeSelector=(ComboBox)window.FindName("ThemeSelector")!;
                Check(themeSelector.Items.Count==3 && themeSelector.IsEnabled,
                    "light dark system theme choices are accessible");
                themeSelector.SelectedValue="Light";
                Check(!ThemeManager.IsDark && ThemeManager.Choice==ThemeChoice.Light,
                    "light theme switch applies immediately");
                for(var i=0;i<90 && !vm.ProbeFresh;i++) await Task.Delay(400);
                Check(vm.ProbeFresh,"visual capture waits for actual live MCP discovery");
                tabs.SelectedIndex=0;
                await Task.Delay(150);
                Screenshot(layout,"gui-overview-100.png");
                tabs.SelectedIndex=1;
                await Task.Delay(180);
                Screenshot(layout,"gui-connection-100.png");
                tabs.SelectedIndex=2;
                await Task.Delay(200);
                Screenshot(layout,"gui-tools-100.png");
                tabs.SelectedIndex=3;
                await Task.Delay(100);
                var logModel=(B4LogCenter)typeof(MainWindow).GetField("logCenter",
                    System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!
                    .GetValue(window)!;
                for(var i=0;i<40 && !logModel.Status.StartsWith("已缓存");i++)await Task.Delay(250);
                Check(logModel.Status.StartsWith("已缓存"),"log center loads bounded actual management API");
                Screenshot(layout,"gui-b4-logs-light.png");
                var logSources=(ComboBox)window.FindName("LogSource")!;
                var logLevels=(ComboBox)window.FindName("LogLevel")!;
                var logSearch=(TextBox)window.FindName("LogQuery")!;
                Check(logSources.Items.Count==3 && logLevels.Items.Count==5,
                    "log source and severity controls available");
                logSources.SelectedIndex=2;
                Check(logModel.Rows.All(x=>x.Source=="管理事件"),
                    "log source filter works on actual events");
                logLevels.SelectedIndex=0;
                logSearch.Text="unlikely-b4-unique-query";
                Check(logModel.Rows.Count==0,"log search no-match rendered");
                logSearch.Text="";
                logSources.SelectedIndex=0;
                Check(logModel.Status.Contains("/200"),"log center displays bounded cache");
                tabs.SelectedIndex=4;
                await Task.Delay(180);
                Screenshot(layout,"gui-settings-100.png");
                var settingsToggle=(System.Windows.Controls.Primitives.ToggleButton)
                    window.FindName("SettingsDetailsToggle")!;
                var settingsPanel=(FrameworkElement)window.FindName("SettingsDetailsPanel")!;
                Check(settingsPanel.Visibility==Visibility.Collapsed,
                    "advanced settings are hidden by default");
                settingsToggle.IsChecked=true;
                Check(settingsPanel.Visibility==Visibility.Visible,
                    "settings details can be expanded");
                settingsToggle.IsChecked=false;
                tabs.SelectedIndex=0;
                var overviewToggle=(System.Windows.Controls.Primitives.ToggleButton)
                    window.FindName("OverviewDetailsToggle")!;
                var overviewPanel=(FrameworkElement)window.FindName("OverviewDetailsPanel")!;
                Check(overviewPanel.Visibility==Visibility.Collapsed,
                    "overview technical details are initially hidden");
                overviewToggle.IsChecked=true;
                await Task.Delay(175);
                Check(overviewPanel.Visibility==Visibility.Visible,
                    "overview technical details expand with light animation");
                overviewToggle.IsChecked=false;
                Check(overviewPanel.Visibility==Visibility.Collapsed,
                    "overview details collapse without losing status");
                themeSelector.SelectedValue="Dark";
                await Task.Delay(100);
                Check(ThemeManager.IsDark && ThemeManager.Choice==ThemeChoice.Dark &&
                      ((SolidColorBrush)Application.Current.Resources["PageBackground"]).Color.R<60,
                    "dark theme has dark canvas and persisted choice");
                Screenshot(layout,"gui-b31-overview-dark.png");
                tabs.SelectedIndex=1;
                await Task.Delay(200);
                Screenshot(layout,"gui-b31-connection-dark.png");
                var connectionToggle=(System.Windows.Controls.Primitives.ToggleButton)
                    window.FindName("ConnectionDetailsToggle")!;
                var connectionPanel=(FrameworkElement)window.FindName("ConnectionDetailsPanel")!;
                Check(connectionPanel.Visibility==Visibility.Collapsed,
                    "advanced transport diagnostics hidden by default");
                connectionToggle.IsChecked=true;
                Check(connectionPanel.Visibility==Visibility.Visible,
                    "advanced connection diagnostics accessible");
                connectionToggle.IsChecked=false;
                tabs.SelectedIndex=2;
                await Task.Delay(130);
                Screenshot(layout,"gui-b31-tools-dark.png");
                tabs.SelectedIndex=3;
                await Task.Delay(130);
                Screenshot(layout,"gui-b4-logs-dark.png");
                tabs.SelectedIndex=4;
                await Task.Delay(130);
                Screenshot(layout,"gui-b31-settings-dark.png");
                themeSelector.SelectedValue="Light";
                Check(!ThemeManager.IsDark &&
                      ((SolidColorBrush)Application.Current.Resources["PageBackground"]).Color.R>200,
                    "theme changes refresh the resource palette");
                ThemeManager.Initialize();
                Check(ThemeManager.Choice==ThemeChoice.Light,
                    "GUI theme preference survives reinitialization");
                themeSelector.SelectedValue="System";
                Check(ThemeManager.Choice==ThemeChoice.System,
                    "follow Windows theme mode selectable");
                var prefFile=ThemeManager.SettingsFile;
                var prefBackup=File.Exists(prefFile)?File.ReadAllBytes(prefFile):null;
                try
                {
                    File.WriteAllText(prefFile,"{malformed preferences");
                    ThemeManager.Initialize();
                    Check(ThemeManager.Choice==ThemeChoice.System,
                        "corrupt theme preferences fall back to system");
                    File.Delete(prefFile);
                    ThemeManager.Initialize();
                    Check(ThemeManager.Choice==ThemeChoice.System,
                        "missing theme preferences fall back to system");
                }
                finally
                {
                    if(prefBackup is null) { if(File.Exists(prefFile)) File.Delete(prefFile); }
                    else File.WriteAllBytes(prefFile,prefBackup);
                    ThemeManager.Initialize();
                }
                Check(themeSelector.Focusable && themeSelector.IsTabStop &&
                      ((ComboBox)window.FindName("ToolMode")!).Focusable &&
                      ((ComboBox)window.FindName("AccessMode")!).Focusable &&
                      ((TextBox)window.FindName("RootPath")!).Focusable,
                    "theme, mode, access and root controls are keyboard focusable");
                themeSelector.SelectedValue="Light";
                tabs.SelectedIndex=0;
                await Task.Delay(160);
                Screenshot(layout,"gui-b31-overview-125.png",1.25);
                layout.LayoutTransform=Transform.Identity;
                tabs.SelectedIndex=4;
                for(var i=0;i<90 && !vm.ProbeFresh;i++)await Task.Delay(400);
                Check(vm.ProbeFresh && vm.ActualToolCount==vm.ExpectedToolCount,
                    "actual MCP count shown from live discovery");
                Check(vm.Tools.Count is 14 or 21,
                    "actual MCP tool list rendered");
                var pidBeforeDiagnostic=vm.Get("actual","pid");
                typeof(MainWindow).GetMethod("Diagnose_Click",
                    System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!
                    .Invoke(window,[window,new RoutedEventArgs(Button.ClickEvent)]);
                for(var i=0;i<90 && !vm.Message.Contains("工具名称与数量一致");i++)
                    await Task.Delay(250);
                Check(vm.Message.Contains("工具名称与数量一致") &&
                      vm.Get("actual","pid")==pidBeforeDiagnostic,
                    "one-click read-only diagnosis preserves engine PID");
                Check(((ComboBox)window.FindName("ToolMode")!).Items.Count==2,
                    "two tool mode choices");
                Check(((ComboBox)window.FindName("AccessMode")!).Items.Count==2,
                    "two file access choices");
                var options=((ComboBox)window.FindName("AccessMode")!).Items.Cast<ComboBoxItem>().ToList();
                Check(!options[1].IsEnabled,"Full disabled for local-dev UI");
                Check(!vm.CanManageHosted && !((ComboBox)window.FindName("ProxyMode")!).IsEnabled &&
                      vm.CredentialStatus.Contains("不使用"),
                    "local development proxy and credentials remain unavailable");
                var wizard=new B4SetupWizard(vm)
                {
                    Left=-32000,Top=-32000,ShowInTaskbar=false,ShowActivated=false,
                    WindowStartupLocation=WindowStartupLocation.Manual
                };
                wizard.Show();
                Check(wizard.Step==0 && wizard.SelectedRoot.Length>0,
                    "wizard opens with actual instance and target configuration");
                var nextButton=(Button)typeof(B4SetupWizard).GetField("next",
                    System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!
                    .GetValue(wizard)!;
                for(var i=0;i<5;i++)
                {
                    nextButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    await Task.Delay(45);
                }
                Check(wizard.Step==5 && wizard.SelectedMode is "files" or "terminal",
                    "six wizard stages accessible without service mutation");
                wizard.Close();
                Check(vm.CanStop && vm.Get("actual","state")=="running",
                    "cancel/close wizard does not stop or reconfigure engine");
                var edit=(TextBox)window.FindName("RootPath")!;
                var originalRoot=edit.Text;
                edit.Text="Z:\\definitely-missing-gui-root";
                typeof(MainWindow).GetMethod("Save_Click",
                    System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!
                    .Invoke(window,[window,new RoutedEventArgs(Button.ClickEvent)]);
                Check(vm.Message.StartsWith("INVALID_ROOT"),
                    "invalid root rejected directly by GUI before any mutation");
                edit.Text=originalRoot;
                Screenshot(layout,"gui-settings-150.png",1.5);
                layout.LayoutTransform=Transform.Identity;
                tabs.SelectedIndex=0;
                window.Width=720;window.Height=520;
                await Task.Delay(200);
                window.UpdateLayout();
                Check(tabs.ActualWidth>300 && tabs.ActualHeight>200,
                    "minimum size navigation accessible");
                Screenshot(layout,"gui-overview-min.png");
            }
            catch(Exception e) { failed=1;Console.Error.WriteLine(e); }
            finally
            {
                if (savedTheme.HasValue) ThemeManager.SetChoice(savedTheme.Value);
                window?.Close();
                File.WriteAllText(Path.Combine(Root,"test-runtime","gui-visual.json"),
                  JsonSerializer.Serialize(new{utc=DateTimeOffset.UtcNow,status=failed==0?"PASS":"FAIL",
                    checks=Checks},new JsonSerializerOptions{WriteIndented=true}));
                app.Shutdown();
            }
        }),DispatcherPriority.ApplicationIdle);
        app.Run();
        Environment.ExitCode=failed;
    }
}
