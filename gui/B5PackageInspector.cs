using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace LocalDC.Gui;

/// <summary>Read-only offline inspection. Deliberately has no register/install/launch capability.</summary>
public sealed record B5PackageEvidence(string FileName, long Bytes, int Entries,
    long TotalExpandedBytes, string Sha256, bool ExpectedMatched, string Description);
public static class B5PackageInspector
{
    public const long MaxArchiveBytes = 2L * 1024 * 1024 * 1024;
    public const long MaxExpandedBytes = 4L * 1024 * 1024 * 1024;
    public const int MaxEntries = 10000;
    private static readonly Regex HashPattern = new("^[0-9a-fA-F]{64}$",RegexOptions.Compiled);
    public static async Task<B5PackageEvidence> InspectAsync(string file,
        string? expectedHash, CancellationToken cancel, IProgress<double>? progress = null)
    {
        if (!Path.IsPathFullyQualified(file) || !File.Exists(file) ||
            !file.EndsWith(".zip",StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("请选择现有本地 ZIP 文件");
        if(!string.IsNullOrWhiteSpace(expectedHash) && !HashPattern.IsMatch(expectedHash.Trim()))
            throw new InvalidDataException("SHA-256 摘要须为64位十六进制");
        var info=new FileInfo(file);
        if(info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("拒绝重解析链接包");
        if(info.Length is <= 0 or > MaxArchiveBytes)
            throw new InvalidDataException("安装包超过2 GiB或文件为空");
        var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long expanded=0;
        int entries=0;
        await using(var fileStream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read,
            64*1024,FileOptions.Asynchronous|FileOptions.SequentialScan))
        using(var zip=new ZipArchive(fileStream,ZipArchiveMode.Read,leaveOpen:true))
        {
            foreach(var entry in zip.Entries)
            {
                cancel.ThrowIfCancellationRequested();
                entries++;
                if(entries>MaxEntries)throw new InvalidDataException("安装包条目超过限制");
                var raw=entry.FullName;
                var normalized=raw.Replace('\\','/');
                if(normalized.Length is 0 or > 300 || normalized.StartsWith('/') ||
                   Regex.IsMatch(normalized,@"^[A-Za-z]:") ||
                   normalized.Contains('\0') || normalized.Contains(':') ||
                   normalized.Split('/').Any(x=>x is "." or "..") ||
                   entry.ExternalAttributes >> 16 is var unix &&
                   (unix & 0xF000)==0xA000)
                    throw new InvalidDataException("安装包包含越界路径、软链接或不安全条目");
                if(!seen.Add(normalized.TrimEnd('/')))
                    throw new InvalidDataException("安装包包含重复或大小写冲突的条目");
                if(entry.Length<0 || expanded>MaxExpandedBytes-entry.Length)
                    throw new InvalidDataException("解压体积超过上限");
                expanded+=entry.Length;
                if(entry.CompressedLength>0 && entry.Length>0 &&
                   entry.Length/Math.Max(1,entry.CompressedLength)>1500)
                    throw new InvalidDataException("压缩比异常，拒绝潜在压缩炸弹");
            }
        }
        if(entries==0)throw new InvalidDataException("空 ZIP 包");
        cancel.ThrowIfCancellationRequested();
        using var hash=SHA256.Create();
        await using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read,
            128*1024,FileOptions.Asynchronous|FileOptions.SequentialScan))
        {
            var buffer=new byte[128*1024];
            int count;
            long done=0;
            while((count=await stream.ReadAsync(buffer,cancel))>0)
            {
                hash.TransformBlock(buffer,0,count,null,0);
                done+=count;
                progress?.Report((double)done/Math.Max(1,info.Length));
            }
            hash.TransformFinalBlock(Array.Empty<byte>(),0,0);
        }
        var digest=Convert.ToHexString(hash.Hash!).ToLowerInvariant();
        var expected=expectedHash?.Trim();
        var match=expected is not null && expected.Length>0 &&
            digest.Equals(expected,StringComparison.OrdinalIgnoreCase);
        if(expected is not null && expected.Length>0 && !match)
            throw new InvalidDataException("SHA-256 不匹配，拒绝候选包");
        return new(Path.GetFileName(file),info.Length,entries,expanded,digest,match,
            match ? "外部摘要一致，仅完成离线预检；版本来源、兼容与安装仍未验证"
                : "已计算 SHA-256、结构安全预检通过；尚未提供可信外部摘要，不可认定安装包可信");
    }
}
