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
    private HashSet<string> lifecycleOperations = new(StringComparer.Ordinal);
    private string? stagedPackagePath;
    private string? stagedPackageSha;
    private string? stagedTrustedSha;
    private string? stagedRevision;
    private string? stagedInstanceKey;
    private string? lastVerifiedId;
    private bool lastVerifiedOk;
    private bool SupportsVersion(string operation) => lifecycleOperations.Contains(operation);
    private void ClearStagedPackage()
    {
        stagedPackagePath=null; stagedPackageSha=null; stagedTrustedSha=null;
        stagedRevision=null; stagedInstanceKey=null;
        if(VersionInstallButton is not null) VersionInstallButton.IsEnabled=false;
    }
    private async Task RefreshLifecycleOperations()
    {
        try
        {
            var capabilities=await client.RequestAsync("capabilities",timeout:TimeSpan.FromSeconds(15));
            var operations=capabilities.GetProperty("operations").EnumerateArray().Select(x=>x.GetString())
                .Where(x=>!string.IsNullOrWhiteSpace(x));
            lifecycleOperations = new(operations!,StringComparer.Ordinal);
        }
        catch { lifecycleOperations.Clear(); }
    }


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
            versionModel.CanChoose(selected.Id) && selected.Id!=versionModel.TargetId &&
            !(SupportsVersion("version.activate") && B5Versions.NeedsManagedActivation(selected));
        VersionRollbackButton.IsEnabled=can && versionModel.HasDistinctRollback &&
            !(SupportsVersion("version.activate") && versionModel.IsManagedRollback);
        VersionVerifyButton.IsEnabled=can && selected is not null && SupportsVersion("version.verify");
        VersionManagedActivate.IsEnabled=can && selected is not null &&
            versionModel.ActualState=="running" && selected.Id!=versionModel.ActualId &&
            SupportsVersion("version.activate") && lastVerifiedOk && lastVerifiedId==selected.Id;
        VersionRemoveButton.IsEnabled=can && selected is not null &&
            SupportsVersion("version.remove") && selected.Id!=versionModel.ActualId &&
            selected.Id!=versionModel.TargetId && selected.Id!=versionModel.RollbackId &&
            !selected.Id.Equals("p6",StringComparison.OrdinalIgnoreCase);
        VersionInstallButton.IsEnabled=can && SupportsVersion("version.install") &&
            stagedPackagePath is not null && stagedTrustedSha is not null &&
            stagedRevision==versionModel.Revision && stagedInstanceKey==versionModel.InstanceKey;
        VersionSelectionHint.Text=selected is null?"选择已注册版本后可执行受控切换。":
            selected.Id==versionModel.TargetId?"已是目标版本；若需调整14/21工具模式，请前往运行设置。":
            B5Versions.NeedsManagedActivation(selected) && SupportsVersion("version.activate")
                ? "受管理的新版本必须先完整性校验，再通过“受控升级并验收”切换；普通 select 不能绕过升级门禁。"
                : $"将切换到 {selected.Label}，沿用当前目标工具模式 {versionModel.TargetMode}。运行服务会受控停止并重新启动。";
    }
    private async Task RefreshVersions(bool force)
    {
        if(closing || vm.Busy || !vm.Fresh || !versionGate.Wait(0))return;
        try
        {
            if(!force && DateTimeOffset.UtcNow-versionLastRead<TimeSpan.FromSeconds(15))return;
            var key=vm.Get("instance","key");
            await RefreshLifecycleOperations();
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
        lastVerifiedOk=false;lastVerifiedId=null;
        if(VersionVerifiedStatus is not null)
            VersionVerifiedStatus.Text="已选择版本；执行完整性校验后可使用受控升级。";
        if(VersionList is not null && VersionSelectButton is not null)UpdateVersionActions();
    }
    private void VersionDiagnostics_Click(object sender,RoutedEventArgs e)=>Pages.SelectedIndex=1;
    private async void VersionSelect_Click(object sender,RoutedEventArgs e)
    {
        if(VersionList.SelectedItem is not RegisteredVersion selected ||
           !versionModel.CanChoose(selected.Id) || selected.Id==versionModel.TargetId || !vm.CanOperate ||
           (SupportsVersion("version.activate") && B5Versions.NeedsManagedActivation(selected)))
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
        if(!vm.CanOperate || !versionModel.HasDistinctRollback ||
           (SupportsVersion("version.activate") && versionModel.IsManagedRollback))return;
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
        ClearStagedPackage();
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
            if(result.ExpectedMatched && !string.IsNullOrWhiteSpace(VersionExpectedHash.Text))
            {
                stagedPackagePath=picker.FileName;
                stagedPackageSha=result.Sha256;
                stagedTrustedSha=VersionExpectedHash.Text.Trim().ToLowerInvariant();
                stagedRevision=versionModel.Revision;
                stagedInstanceKey=versionModel.InstanceKey;
            }
            VersionPreflightStatus.Text=$"{result.FileName} · {result.Entries} 项 · " +
                $"{result.Bytes/1024.0/1024:0.0} MiB\nSHA-256：{result.Sha256}\n{result.Description}\n" +
                (result.ExpectedMatched && SupportsVersion("version.install")
                    ? "可信摘要已匹配；可确认安装，安装不会立即切换运行版本。"
                    : "缺少可信外部 SHA-256 或管理核心不支持安装：只能只读预检。");
            UpdateVersionActions();
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

    private async void VersionVerify_Click(object sender,RoutedEventArgs e)
    {
        if(VersionList.SelectedItem is not RegisteredVersion chosen || !SupportsVersion("version.verify"))return;
        var key=versionModel.InstanceKey;
        lastVerifiedOk=false;lastVerifiedId=null;
        UpdateVersionActions();
        try
        {
            var report=await client.RequestAsync("version.verify",new {id=chosen.Id},
                timeout:TimeSpan.FromSeconds(120));
            if(closing || versionModel.InstanceKey!=key || VersionList.SelectedItem is not RegisteredVersion current ||
               current.Id!=chosen.Id)return;
            lastVerifiedId=chosen.Id;
            lastVerifiedOk=GuiState.Value(report,"verified")=="True";
            VersionVerifiedStatus.Text=lastVerifiedOk
                ? $"版本 {chosen.Id} 的已固定不可变文件通过完整性校验；运行健康与真实 MCP 仍待独立验证。"
                : $"版本 {chosen.Id} 的完整性状态：{GuiState.Value(report,"status")??"未知"}；不允许受控升级。";
        }
        catch(Exception)
        {
            VersionVerifiedStatus.Text="版本完整性检查失败，请检查注册表或管理日志。";
        }
        UpdateVersionActions();
    }
    private async void VersionManagedActivate_Click(object sender,RoutedEventArgs e)
    {
        if(VersionList.SelectedItem is not RegisteredVersion choice || !lastVerifiedOk ||
           choice.Id!=lastVerifiedId || !SupportsVersion("version.activate"))return;
        var expected=versionModel.Revision;
        var id=choice.Id;
        var mode=versionModel.TargetMode;
        if(mode is not ("files" or "terminal") || !Confirm(
            $"确认受控升级至 {choice.Label} · {mode}？\n这将停止当前实例并启动目标版本；失败时管理核心将尝试恢复旧版本。终端模式使用 Windows 用户权限。"))
            return;
        var success=false;
        await Run(async() =>
        {
            await Read();
            if(expected!=vm.Get("configuration","revision") ||
               versionModel.InstanceKey!=vm.Get("instance","key"))
                throw new InvalidOperationException("REVISION_CONFLICT：请重新读取版本状态");
            var result=await client.RequestAsync("version.verify",new {id},
                timeout:TimeSpan.FromSeconds(120));
            if(GuiState.Value(result,"verified")!="True")
                throw new InvalidOperationException("VERSION_UNVERIFIED：目标文件已改变");
            await Mutate("version.activate",new {confirmed=true,revision=expected,version=id,mode}, TimeSpan.FromMinutes(5));
            success=true;
        });
        lastVerifiedOk=false;
        await RefreshVersions(true);
        if(success){LoadForm();Pages.SelectedIndex=1;await Inspect(true);}
        else
        {
            await Read();
            LoadForm();
            vm.Message="受控升级未完成；请检查实际进程和任务日志，确认自动恢复是否成功。";
        }
    }
    private async void VersionRemove_Click(object sender,RoutedEventArgs e)
    {
        if(VersionList.SelectedItem is not RegisteredVersion target || !SupportsVersion("version.remove"))
            return;
        var id=target.Id;
        var rev=versionModel.Revision;
        if(!Confirm($"删除当前实例中未使用的受管理版本 {id}？\n此操作删除已安装文件，不涉及当前运行、目标或回滚版本。"))
            return;
        await Run(async() =>
        {
            await Read();
            if(rev!=vm.Get("configuration","revision") ||
               versionModel.InstanceKey!=vm.Get("instance","key"))
                throw new InvalidOperationException("REVISION_CONFLICT：配置已改变");
            await Mutate("version.remove",new {confirmed=true,revision=rev,id}, TimeSpan.FromMinutes(5));
        });
        await RefreshVersions(true);
    }
    private async void VersionInstall_Click(object sender,RoutedEventArgs e)
    {
        if(!SupportsVersion("version.install") || stagedPackagePath is null ||
           stagedTrustedSha is null || stagedRevision is null ||
           stagedInstanceKey!=versionModel.InstanceKey ||
           stagedRevision!=versionModel.Revision)return;
        var path=stagedPackagePath;
        var sha=stagedTrustedSha;
        var rev=stagedRevision;
        if(!Confirm("使用外部可信 SHA-256 对照安装版本候选？\n管理核心会校验每个文件并注册版本；不会立即启用。"))
            return;
        var completed=false;
        await Run(async() =>
        {
            await Read();
            if(rev!=vm.Get("configuration","revision") ||
                stagedInstanceKey!=vm.Get("instance","key"))
                throw new InvalidOperationException("REVISION_CONFLICT：需重新预检包并读取版本状态");
            var checkedZip=await B5PackageInspector.InspectAsync(path,sha,CancellationToken.None);
            if(!checkedZip.ExpectedMatched || checkedZip.Sha256!=stagedPackageSha)
                throw new InvalidDataException("PACKAGE_HASH_MISMATCH");
            await Mutate("version.install",new {confirmed=true,revision=rev,path,sha256=sha}, TimeSpan.FromMinutes(5));
            completed=true;
        });
        ClearStagedPackage();
        await RefreshVersions(true);
        VersionPreflightStatus.Text=completed
            ? "安装与注册完成，已刷新版本列表；本次没有启动新版本。"
            : "安装未完成。请检查管理任务及错误日志，重新预检后再试。";
    }

}
