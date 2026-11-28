using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Win32;

namespace LocalDC.Gui;

public partial class MainWindow
{
    private readonly B5Versions versionModel = new();
    private readonly SemaphoreSlim versionGate = new(1,1);
    private DateTimeOffset versionLastRead = DateTimeOffset.MinValue;
    private PublishedRelease? latestRelease;
    private CancellationTokenSource? packageCheckCancel;
    private bool releaseChecking;

    private void InitializeB5()
    {
        VersionPanel.DataContext=versionModel;
        Pages.SelectionChanged += async (sender,args) =>
        {
            if(ReferenceEquals(args.Source,Pages) && Pages.SelectedIndex==4)
                await RefreshVersions(true);
        };
    }
    private void VersionDetails_Changed(object sender,RoutedEventArgs e)
    {
        if(VersionDetailsPanel is not null)ToggleDetails(VersionDetailsToggle,VersionDetailsPanel);
    }
    private void UpdateVersionActions()
    {
        var selected=VersionList.SelectedItem as RegisteredVersion;
        var can=versionModel.Fresh && !vm.Busy && vm.CanOperate &&
            vm.Get("actual","state") is not ("unsafe" or "starting");
        VersionSelectButton.IsEnabled=can && selected is not null &&
            versionModel.CanChoose(selected.Id) && selected.Id!=versionModel.TargetId;
        VersionRollbackButton.IsEnabled=can && versionModel.HasDistinctRollback;
        VersionSelectionHint.Text=selected is null?"选择已注册版本后可执行受控切换。":
            selected.Id==versionModel.TargetId?"已是目标版本；若需调整14/21工具模式，请前往运行设置。":
            $"将切换到 {selected.Label}，沿用当前目标工具模式 {versionModel.TargetMode}。运行服务会受控停止并重新启动。";
    }
    private async Task RefreshVersions(bool force)
    {
        if(closing || vm.Busy || !vm.Fresh || !versionGate.Wait(0))return;
        try
        {
            if(!force && DateTimeOffset.UtcNow-versionLastRead<TimeSpan.FromSeconds(15))return;
            var key=vm.Get("instance","key");
            var response=await client.RequestAsync("versions",timeout:TimeSpan.FromSeconds(20));
            if(closing || vm.Get("instance","key")!=key)return;
            versionModel.Apply(response,vm.Snapshot);
            versionLastRead=DateTimeOffset.UtcNow;
            UpdateVersionActions();
        }
        catch(Exception ex)
        {
            versionModel.Invalidate(ex.Message);
            UpdateVersionActions();
        }
        finally {versionGate.Release();}
    }
    private async void VersionsRefresh_Click(object sender,RoutedEventArgs e)
    {
        await Refresh(false);
        await RefreshVersions(true);
    }
    private void VersionSelection_Changed(object sender,SelectionChangedEventArgs e)
    {
        if(VersionList is not null && VersionSelectButton is not null)UpdateVersionActions();
    }
    private void VersionDiagnostics_Click(object sender,RoutedEventArgs e)=>Pages.SelectedIndex=1;
    private async void VersionSelect_Click(object sender,RoutedEventArgs e)
    {
        if(VersionList.SelectedItem is not RegisteredVersion selected ||
           !versionModel.CanChoose(selected.Id) || selected.Id==versionModel.TargetId || !vm.CanOperate)
            return;
        var oldRevision=versionModel.Revision;
        var mode=versionModel.TargetMode;
        var id=selected.Id;
        if(mode is not ("files" or "terminal")){vm.Message="目标工具模式无效";return;}
        var text=$"确认切换当前实例至已注册版本 {selected.Label} ({id})？\n" +
            "运行中的 MCP 进程可能被停止并重新启动；实际可用性以健康和工具发现验证为准。" +
            (mode=="terminal"?"\n完整终端模式将使用当前 Windows 用户权限。":"");
        if(!Confirm(text))return;
        var succeeded=false;
        await Run(async()=>
        {
            await Read();
            if(versionModel.InstanceKey!=vm.Get("instance","key") ||
               oldRevision!=vm.Get("configuration","revision"))
                throw new InvalidOperationException("REVISION_CONFLICT：版本目标已变更，请刷新后重试");
            if(vm.Get("actual","state") is "unsafe" or "starting")
                throw new InvalidOperationException("实例当前状态不允许切换版本");
            var versions=await client.RequestAsync("versions");
            if(!versions.EnumerateArray().Any(x=>
               (GuiState.Value(x,"Id")??GuiState.Value(x,"id"))==id))
                throw new InvalidOperationException("目标版本不在最新的共享注册表");
            await Mutate("select",new {confirmed=true,revision=oldRevision,version=id,mode});
            succeeded=true;
        });
        await RefreshVersions(true);
        if(succeeded){LoadForm();Pages.SelectedIndex=1;await Inspect(true);}
    }
    private async void VersionRollback_Click(object sender,RoutedEventArgs e)
    {
        if(!vm.CanOperate || !versionModel.HasDistinctRollback)return;
        var rev=versionModel.Revision;
        var candidate=versionModel.RollbackId;
        var mode=versionModel.RollbackMode;
        var message=$"确认执行共享管理核心已注册的回滚目标 {candidate} / {mode}？\n"+
            "运行中的服务可能被停止；执行结束后仍需重新检查健康及 MCP 工具。"+
            (candidate==versionModel.TargetId?"\n这只是工具模式回滚，不是跨版本回滚。":"");
        if(!Confirm(message))return;
        var succeeded=false;
        await Run(async()=>
        {
            await Read();
            if(rev!=vm.Get("configuration","revision") ||
               versionModel.InstanceKey!=vm.Get("instance","key"))
                throw new InvalidOperationException("REVISION_CONFLICT：回滚目标或配置已变动");
            if(vm.Get("actual","state") is "unsafe" or "starting")
                throw new InvalidOperationException("当前进程状态不允许回滚");
            var currentRollback=vm.Get("configuration","rollback","version");
            var currentMode=vm.Get("configuration","rollback","mode");
            if(currentRollback!=candidate || currentMode!=mode)
                throw new InvalidOperationException("回滚目标已改变");
            var registered=await client.RequestAsync("versions");
            if(!registered.EnumerateArray().Any(x=>
              (GuiState.Value(x,"Id")??GuiState.Value(x,"id"))==candidate))
                throw new InvalidOperationException("回滚版本不在注册表");
            await Mutate("rollback",new {confirmed=true});
            succeeded=true;
        });
        await RefreshVersions(true);
        if(succeeded){LoadForm();Pages.SelectedIndex=1;await Inspect(true);}
    }
    private async void VersionCheckRelease_Click(object sender,RoutedEventArgs e)
    {
        if(releaseChecking)return;
        releaseChecking=true;
        latestRelease=null;
        VersionOpenRelease.IsEnabled=false;
        VersionReleaseStatus.Text="正在只读查询 GitHub 官方发行版…";
        try
        {
            var releases=await B5ReleaseFeed.CheckAsync(CancellationToken.None);
            if(closing)return;
            latestRelease=releases.OrderByDescending(x=>x.PublishedAt).FirstOrDefault();
            if(latestRelease is null)
                VersionReleaseStatus.Text="未找到符合格式的发行版；本地版本状态不受影响。";
            else
            {
                var current=versionModel.Entries.FirstOrDefault(x=>x.Id==versionModel.TargetId);
                // Engine registry IDs (p6) and GitHub release semver are separate.
                VersionReleaseStatus.Text=$"最新发布：{latestRelease.Tag} · {latestRelease.Category} · "+
                    $"{latestRelease.PublishedAt.ToLocalTime():yyyy-MM-dd}\n"+
                    $"发行说明：{latestRelease.Name}\n"+
                    (string.IsNullOrWhiteSpace(latestRelease.Notes) ? "" :
                        latestRelease.Notes[..Math.Min(420,latestRelease.Notes.Length)] + "\n")+
                    "已登记引擎版本标识与发行版本号不是同一概念；此检查不安装或修改运行版本。";
                VersionOpenRelease.IsEnabled=true;
            }
        }
        catch(Exception ex)
        {
            if(!closing)VersionReleaseStatus.Text="发行查询不可用：" + ex.GetType().Name +
                "。请检查网络及代理；没有修改配置。";
        }
        finally{releaseChecking=false;}
    }
    private void VersionOpenRelease_Click(object sender,RoutedEventArgs e)
    {
        if(latestRelease is null)return;
        try {Process.Start(new ProcessStartInfo(latestRelease.Url){UseShellExecute=true});}
        catch {VersionReleaseStatus.Text="无法打开发行页面。";}
    }
    private async void VersionPreflight_Click(object sender,RoutedEventArgs e)
    {
        if(packageCheckCancel is not null)return;
        var picker=new OpenFileDialog{Title="选择离线版本候选包（只读检查）",
            Filter="ZIP 安装包 (*.zip)|*.zip",Multiselect=false,CheckFileExists=true};
        if(picker.ShowDialog(this)!=true)return;
        using var cts=new CancellationTokenSource();
        packageCheckCancel=cts;
        VersionPreflightButton.IsEnabled=false;
        VersionCancelPreflight.IsEnabled=true;
        VersionPreflightProgress.Value=0;
        VersionPreflightStatus.Text="正在检查 ZIP 安全结构及 SHA-256…";
        var progress=new Progress<double>(x=>VersionPreflightProgress.Value=Math.Round(x*100));
        try
        {
            var result=await B5PackageInspector.InspectAsync(picker.FileName,
                VersionExpectedHash.Text,cts.Token,progress);
            if(closing)return;
            VersionPreflightProgress.Value=100;
            VersionPreflightStatus.Text=$"{result.FileName} · {result.Entries} 项 · " +
                $"{result.Bytes/1024.0/1024:0.0} MiB\nSHA-256：{result.Sha256}\n{result.Description}\n" +
                "版本注册与正式安装需共享管理核心支持，此处不会启用安装按钮。";
        }
        catch(OperationCanceledException)
        {
            VersionPreflightStatus.Text="已取消离线预检，服务与文件均未修改。";
        }
        catch(Exception ex)
        {
            VersionPreflightStatus.Text="候选包拒绝：" + ex.Message;
        }
        finally
        {
            packageCheckCancel=null;
            VersionPreflightButton.IsEnabled=true;
            VersionCancelPreflight.IsEnabled=false;
        }
    }
    private void VersionCancelPreflight_Click(object sender,RoutedEventArgs e)
        =>packageCheckCancel?.Cancel();
}
