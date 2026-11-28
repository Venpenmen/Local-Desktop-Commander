using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace LocalDC.Gui;

public enum ThemeChoice { System, Light, Dark }

public static class ThemeManager
{
    private sealed record Preferences(string Theme);
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LocalDC", "gui-preferences.json");
    private static bool subscribed;
    public static ThemeChoice Choice { get; private set; } = ThemeChoice.System;
    public static bool IsDark { get; private set; }
    public static string SettingsFile => SettingsPath;
    private static readonly Dictionary<string, (string Light, string Dark)> Colors = new()
    {
        ["PageBackground"] = ("#F2F5F9","#171D26"),
        ["Surface"] = ("#FFFFFF","#242D39"),
        ["SurfaceAlt"] = ("#F7F9FC","#2D3746"),
        ["Sidebar"] = ("#F8FAFD","#1C2430"),
        ["NavSelected"] = ("#E1EBFA","#35475E"),
        ["TextPrimary"] = ("#243248","#EDF2F8"),
        ["TextSecondary"] = ("#627187","#ACBACB"),
        ["Border"] = ("#DCE4EF","#3A4758"),
        ["Accent"] = ("#2863B2","#8AB8FC"),
        ["AccentFill"] = ("#2863B2","#3F78C7"),
        ["AccentText"] = ("#FFFFFF","#FFFFFF"),
        ["Success"] = ("#258253","#77D4A0"),
        ["Warning"] = ("#A86F22","#F0BB77"),
        ["Danger"] = ("#BF4646","#F39B9B"),
        ["MutedFill"] = ("#EEF2F8","#303C4B"),
    };
    public static void Initialize()
    {
        Choice = ThemeChoice.System;
        try
        {
            if (File.Exists(SettingsPath))
            {
                var saved = JsonSerializer.Deserialize<Preferences>(File.ReadAllText(SettingsPath));
                if (Enum.TryParse<ThemeChoice>(saved?.Theme, true, out var mode) &&
                    Enum.IsDefined(mode)) Choice = mode;
            }
        }
        catch (Exception) { Choice = ThemeChoice.System; } // malformed preferences are non-critical
        if (!subscribed)
        {
            SystemEvents.UserPreferenceChanged += (_, _) =>
                Application.Current?.Dispatcher.BeginInvoke(new Action(() =>
                {
                    if (Choice == ThemeChoice.System) Apply();
                }));
            subscribed = true;
        }
        Apply();
    }
    public static void SetChoice(ThemeChoice choice)
    {
        if (!Enum.IsDefined(choice)) return;
        Choice = choice;
        Apply();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var temp = SettingsPath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new Preferences(choice.ToString())));
            File.Move(temp, SettingsPath, true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
    private static bool SystemDark()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var value = key?.GetValue("AppsUseLightTheme");
            return value is int n && n == 0;
        }
        catch { return false; }
    }
    public static void Apply()
    {
        IsDark = Choice == ThemeChoice.Dark || (Choice == ThemeChoice.System && SystemDark());
        if (Application.Current is not { } app) return;
        foreach (var pair in Colors)
        {
            var color = (Color)ColorConverter.ConvertFromString(
                IsDark ? pair.Value.Dark : pair.Value.Light);
            // Theme switches replace brushes: WPF resources can freeze shared instances.
            app.Resources[pair.Key] = new SolidColorBrush(color);
        }
    }
}
