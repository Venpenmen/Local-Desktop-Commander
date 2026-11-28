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
        if (panel is not null) panel.Background = new SolidColorBrush(Color.FromRgb(244, 246, 248));
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
            try
            {
                window = new MainWindow
                {
                    Left = -32000, Top = -32000, ShowInTaskbar=false, ShowActivated=false,
                    WindowStartupLocation=WindowStartupLocation.Manual
                };
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
                Check(tabs.Items.Count==4,"overview, connection, tools and settings navigation");
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
                await Task.Delay(180);
                Screenshot(layout,"gui-settings-100.png");
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
