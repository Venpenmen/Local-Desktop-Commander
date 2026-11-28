using System.Windows;

namespace LocalDC.Gui;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        ThemeManager.Initialize();
        base.OnStartup(e);
    }
}
