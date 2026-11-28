using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using LocalDC.Gui;

internal static class Program
{
    private static readonly List<string> Passed = [];
    private static readonly string Workspace = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    private static string Evidence = Path.Combine(Workspace, "test-runtime", "gui-e2e.json");
    private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(110);
    private static int result;

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Contains("--partial-recovery")) Evidence = Path.Combine(Workspace,"test-runtime","gui-partial-recovery.json");
        // Runs completely off screen without activating or foregrounding the user's desktop.
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.DispatcherUnhandledException += (_, e) =>
        {
            Console.Error.WriteLine("UI DISPATCH FAILURE: " + e.Exception);
            result = 1;
            e.Handled = true;
            app.Shutdown();
        };
        app.Dispatcher.BeginInvoke(new Action(async () =>
        {
            try { if (args.Contains("--partial-recovery")) await PartialRecoveryAsync(); else await RunAsync(); }
            catch (Exception error)
            {
                Console.Error.WriteLine("GUI E2E FAILED: " + error);
                result = 1;
            }
            finally
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Evidence)!);
                File.WriteAllText(Evidence, JsonSerializer.Serialize(
                    new { utc = DateTimeOffset.UtcNow, passed = Passed, status = result == 0 ? "PASS" : "FAIL" },
                    new JsonSerializerOptions { WriteIndented = true }));
                app.Shutdown();
            }
        }), DispatcherPriority.ApplicationIdle);
        app.Run();
        Environment.ExitCode = result;
    }

    private static void Pass(bool ok, string name)
    {
        if (!ok) throw new InvalidOperationException("FAIL " + name);
        Passed.Add(name);
        Console.WriteLine("PASS " + name);
    }

    private static MainWindow NewWindow(Func<string,bool> confirmation)
    {
        var window = new MainWindow
        {
            Left = -32000, Top = -32000, ShowInTaskbar = false,
            ShowActivated = false, WindowStartupLocation = WindowStartupLocation.Manual
        };
        typeof(MainWindow).GetProperty("ConfirmationForTests", Private)!
            .SetValue(window, confirmation);
        window.Show();
        return window;
    }

    private static GuiState Model(MainWindow window) =>
        (GuiState)typeof(MainWindow).GetField("vm", Private)!.GetValue(window)!;

    private static void Click(MainWindow window, string handler)
    {
        typeof(MainWindow).GetMethod(handler, Private)!
            .Invoke(window, [window, new RoutedEventArgs(Button.ClickEvent)]);
    }

    private static async Task Until(Func<bool> condition, string label)
    {
        var deadline = DateTime.UtcNow + Timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            await Task.Delay(250);
        }
        throw new TimeoutException(label);
    }

    private static async Task Stable(GuiState vm, string expected)
    {
        await Until(() => vm.Fresh && !vm.Busy && vm.Get("actual","state") == expected,
            "GUI did not reach " + expected + " (" + vm.Message + ")");
    }

    private static void Choose(MainWindow window, string mode, string root)
    {
        ((ComboBox)window.FindName("ToolMode")!).SelectedValue = mode;
        ((TextBox)window.FindName("RootPath")!).Text = root;
    }

    private static async Task RunAsync()
    {
        var client = new ManagementClient(Workspace);
        var initial = await client.RequestAsync("state");
        Pass(GuiState.Value(initial, "instance","id") == "gui" &&
             GuiState.Value(initial, "instance","transport") == "local-dev",
             "GUI E2E fixture identity");
        var original = GuiState.Value(initial,"actual","state")!;
        var initialRoot = GuiState.Value(initial,"fileAccess","target","allowedRoot")!;
        var initialMode = GuiState.Value(initial,"configuration","target","mode")!;
        var work = Path.Combine(Workspace,"engine","workspace","gui-e2e-subroot");
        Directory.CreateDirectory(work);
        MainWindow? window = null;
        var approvals = new List<string>();
        try
        {
            if(original == "running")
            {
                await client.RequestAsync("stop", new { confirmed=true });
            }
            window = NewWindow(s => { approvals.Add(s); return false; });
            var vm = Model(window);
            await Until(() => vm.Fresh, "initial GUI state");
            await Stable(vm, "stopped");
            Pass(vm.CanStart && !vm.CanStop && !vm.FullAvailable,
                "actual button gates and development Full restriction");
            Pass(vm.InstanceLabel.Contains("gui") && vm.TargetDetails.Contains("restricted"),
                "live WPF data binding initial state");

            Click(window, "Start_Click");
            await Task.Delay(350);
            Pass(approvals.Count == 1 && vm.Get("actual","state") == "stopped",
                "GUI start confirmation decline has no side effect");

            typeof(MainWindow).GetProperty("ConfirmationForTests",Private)!.SetValue(
                window, (Func<string,bool>)(s => { approvals.Add(s); return true; }));
            Click(window, "Start_Click");
            await Stable(vm, "running");
            Pass(vm.CanStop && vm.ConnectionDetails.Contains("本地就绪"),
                "GUI start updates actual and readiness fields");
            var actual = await client.RequestAsync("state");
            Pass(GuiState.Value(actual,"actual","state") == "running",
                "GUI start observable in independent TUI/CLI");

            Click(window, "Stop_Click");
            await Stable(vm, "stopped");
            Pass(GuiState.Value(await client.RequestAsync("state"),"actual","state") == "stopped",
                "GUI stop visible to independent TUI/CLI");

            // A valid, external CLI change makes GUI's retained form revision stale.
            var s = await client.RequestAsync("state");
            await client.RequestAsync("root.set", new {
                confirmed=true, version="p6", revision=GuiState.Value(s,"configuration","revision"), path=work
            });
            Choose(window,"terminal",work);
            Click(window, "Save_Click");
            await Until(() => vm.Message.Contains("REVISION_CONFLICT"), "revision conflict feedback");
            Pass(vm.Message.Contains("REVISION_CONFLICT") &&
                 GuiState.Value(await client.RequestAsync("state"),"configuration","target","mode")=="files",
                 "stale GUI form cannot overwrite TUI changes");

            Click(window, "Load_Click");
            await Until(() => ((TextBox)window.FindName("RootPath")!).Text == work,
                "reload external configuration");
            Pass(((TextBox)window.FindName("RootPath")!).Text == work,
                "GUI pulls external root update");

            Choose(window,"terminal",work);
            Click(window, "SaveStart_Click");
            await Stable(vm, "running");
            var terminal = await client.RequestAsync("state");
            Pass(GuiState.Value(terminal,"actual","mode")=="terminal" &&
                 GuiState.Value(terminal,"fileAccess","actual","mode")=="restricted",
                 "GUI save and launch terminal changes actual configuration");

            Click(window,"Restart_Click");
            await Stable(vm, "running");
            Pass(vm.CanStop,"GUI restart returns to ready service");

            // Closing the real WPF window does not kill the separately owned engine.
            window.Close();
            window=null;
            await Task.Delay(800);
            Pass(GuiState.Value(await client.RequestAsync("state"),"actual","state")=="running",
                "closing GUI retains MCP engine process");

            window=NewWindow(_=>true);
            vm=Model(window);
            await Stable(vm,"running");
            Pass(vm.Get("actual","mode")=="terminal",
                "reopening GUI restores service status");

            Click(window,"Stop_Click");
            await Stable(vm,"stopped");
            s=await client.RequestAsync("state");
            await client.RequestAsync("root.set",new {
                confirmed=true,version="p6",revision=GuiState.Value(s,"configuration","revision"),path=initialRoot
            });
            s=await client.RequestAsync("state");
            await client.RequestAsync("select",new {
                confirmed=true,version="p6",mode=initialMode,revision=GuiState.Value(s,"configuration","revision")
            });
            Pass(GuiState.Value(await client.RequestAsync("state"),"fileAccess","target","allowedRoot")==initialRoot,
                 "restored original GUI target root");
        }
        finally
        {
            if(window is not null) window.Close();
            var now=await client.RequestAsync("state");
            if (GuiState.Value(now,"actual","state")=="running" &&
                (GuiState.Value(now,"fileAccess","target","allowedRoot")!=initialRoot ||
                 GuiState.Value(now,"configuration","target","mode")!=initialMode))
            {
                await client.RequestAsync("stop",new {confirmed=true});
                now=await client.RequestAsync("state");
            }
            if (GuiState.Value(now,"actual","state")=="stopped")
            {
                if(GuiState.Value(now,"fileAccess","target","allowedRoot")!=initialRoot)
                {
                    await client.RequestAsync("root.set",new{confirmed=true,version="p6",
                        revision=GuiState.Value(now,"configuration","revision"),path=initialRoot});
                    now=await client.RequestAsync("state");
                }
                if(GuiState.Value(now,"configuration","target","mode")!=initialMode)
                    await client.RequestAsync("select",new{confirmed=true,version="p6",
                        revision=GuiState.Value(now,"configuration","revision"),mode=initialMode});
                if(original=="running")await client.RequestAsync("start",new{confirmed=true});
            }
        }
    }

    private static async Task PartialRecoveryAsync()
    {
        var client = new ManagementClient(Workspace);
        var first = await client.RequestAsync("state");
        Pass(GuiState.Value(first,"instance","id")=="gui","partial recovery isolated fixture");
        var initialState = GuiState.Value(first,"actual","state")!;
        var initialRoot = GuiState.Value(first,"fileAccess","target","allowedRoot")!;
        var initialMode = GuiState.Value(first,"configuration","target","mode")!;
        var candidate = Path.Combine(Workspace,"engine","workspace","gui-partial-recovery");
        Directory.CreateDirectory(candidate);
        MainWindow? window = null;
        try
        {
            if(initialState=="running") await client.RequestAsync("stop",new{confirmed=true});
            window=NewWindow(_=>true);
            var vm=Model(window);
            await Stable(vm,"stopped");
            Pass(vm.Get("configuration","target","mode")==initialMode,
                "partial recovery starts from original mode");
            var action = (Func<Task>)(async () =>
            {
                var before = await client.RequestAsync("state");
                await client.RequestAsync("root.set",new{
                    confirmed=true,version="p6",
                    revision=GuiState.Value(before,"configuration","revision"),path=candidate
                });
                throw new InvalidOperationException("GUI_PARTIAL_WRITE_SIMULATED");
            });
            var run = (Task)typeof(MainWindow).GetMethod("Run",Private)!
                .Invoke(window,[action])!;
            await run;
            Pass(vm.Message.Contains("GUI_PARTIAL_WRITE_SIMULATED"),
                "partial success followed by failure reported to user");
            Pass(((TextBox)window.FindName("RootPath")!).Text == candidate,
                "GUI reloads actual target after partial write failure");
            var actual=await client.RequestAsync("state");
            Pass(GuiState.Value(actual,"fileAccess","target","allowedRoot")==candidate &&
                 GuiState.Value(actual,"configuration","target","mode")==initialMode,
                 "partial write kept first successful mutation, not false success");
            var stale=GuiState.Value(first,"configuration","revision");
            Pass(stale!=GuiState.Value(actual,"configuration","revision"),
                "partial write advanced revision safely");
        }
        finally
        {
            window?.Close();
            var current=await client.RequestAsync("state");
            if (GuiState.Value(current,"actual","state")=="running")
            {
                await client.RequestAsync("stop",new{confirmed=true});
                current=await client.RequestAsync("state");
            }
            if(GuiState.Value(current,"fileAccess","target","allowedRoot")!=initialRoot)
            {
                await client.RequestAsync("root.set",new{confirmed=true,version="p6",
                    revision=GuiState.Value(current,"configuration","revision"),path=initialRoot});
                current=await client.RequestAsync("state");
            }
            if(GuiState.Value(current,"configuration","target","mode")!=initialMode)
                await client.RequestAsync("select",new{confirmed=true,version="p6",
                    revision=GuiState.Value(current,"configuration","revision"),mode=initialMode});
            if(initialState=="running") await client.RequestAsync("start",new{confirmed=true});
        }
    }
}
