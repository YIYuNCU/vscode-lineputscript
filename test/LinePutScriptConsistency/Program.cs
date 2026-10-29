using System.Text;
using LinePutScript;

// 用法：
//   dotnet run --project test/LinePutScriptConsistency            校验 test/fixtures/*.lps
//   dotnet run --project test/LinePutScriptConsistency -- a.lps   额外校验指定的 .lps 文件（可多个）
//   dotnet run --project test/LinePutScriptConsistency -- --dump file.lps   输出 C# 解析后的 JSON，供 TS 侧对照
//   dotnet run --project test/LinePutScriptConsistency -- --dump-many cases.json   cases.json 为字符串数组（每项一份 .lps 文本），输出每份的 dump 数组（供 test/tools/diff-fuzz.js 使用）
string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
string fixtures = Path.Combine(root, "test", "fixtures");

if (args.Length == 2 && args[0] == "--dump")
{
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Out.Write(DumpJson(File.ReadAllText(args[1], Encoding.UTF8)));
    return;
}

if (args.Length == 2 && args[0] == "--dump-many")
{
    Console.OutputEncoding = new UTF8Encoding(false);
    string[] cases = System.Text.Json.JsonSerializer.Deserialize<string[]>(File.ReadAllText(args[1], Encoding.UTF8)) ?? Array.Empty<string>();
    var outSb = new StringBuilder("[");
    for (int i = 0; i < cases.Length; i++)
    {
        if (i > 0) outSb.Append(',');
        outSb.Append(DumpCase(cases[i]));
    }
    Console.Out.Write(outSb.Append(']').ToString());
    return;
}

IEnumerable<string> files = Directory.EnumerateFiles(fixtures, "*.lps").OrderBy(static x => x).Concat(args);

foreach (string file in files)
{
    string input = File.ReadAllText(file, Encoding.UTF8);
    string expected = NormalizeLikeCSharpLoad(input);
    string actual = new LpsDocument(input).ToString();

    if (actual != expected)
    {
        Console.Error.WriteLine($"Consistency failed for {Path.GetFileName(file)}");
        Console.Error.WriteLine("Expected:");
        Console.Error.WriteLine(expected);
        Console.Error.WriteLine("Actual:");
        Console.Error.WriteLine(actual);
        Environment.ExitCode = 1;
        return;
    }
}

Console.WriteLine("LinePutScript UTF-8 consistency fixtures passed.");

static string NormalizeLikeCSharpLoad(string input)
{
    return string.Join('\n', input
        .Replace("\r", "")
        .Replace(":\n|", "/n")
        .Replace(":\n:", "")
        .Trim('\n')
        .Split('\n', StringSplitOptions.RemoveEmptyEntries)
        .Select(static line => line.StartsWith("///", StringComparison.Ordinal) ? $":|{line}" : line));
}

// 以 C# 库的解析结果输出 JSON：name / 原始 info / 反转义 info / 原始 text / 反转义 text / 注释 / subs
static string DumpJson(string input) => DumpDocument(new LpsDocument(input));

// --dump-many 的单个用例：{ lines, toString, deReplace, replace }；任一环节抛异常时输出 { error }
static string DumpCase(string input)
{
    try
    {
        var doc = new LpsDocument(input);
        return "{\"lines\":" + DumpDocument(doc)
            + ",\"toString\":" + Q(doc.ToString())
            + ",\"deReplace\":" + Q(Sub.TextDeReplace(input))
            + ",\"replace\":" + Q(Sub.TextReplace(input)) + "}";
    }
    catch (Exception ex)
    {
        return "{\"error\":" + Q(ex.GetType().Name + ": " + ex.Message) + "}";
    }
}

static string DumpDocument(LpsDocument doc)
{
    var sb = new StringBuilder("[");
    bool first = true;
    foreach (ILine line in doc)
    {
        if (!first) sb.Append(',');
        first = false;
        var l = (Line)line;
        sb.Append("{\"name\":").Append(Q(l.Name))
          .Append(",\"info\":").Append(Q(l.info.GetStoreString()))
          .Append(",\"decodedInfo\":").Append(Q(l.Info))
          .Append(",\"text\":").Append(Q(l.text))
          .Append(",\"decodedText\":").Append(Q(l.Text))
          .Append(",\"comments\":").Append(Q(l.Comments))
          .Append(",\"subs\":[");
        for (int i = 0; i < l.Subs.Count; i++)
        {
            if (i > 0) sb.Append(',');
            var s = l.Subs[i];
            sb.Append("{\"name\":").Append(Q(s.Name))
              .Append(",\"info\":").Append(Q(s.GetStoreString()))
              .Append(",\"decodedInfo\":").Append(Q(s.Info)).Append('}');
        }
        sb.Append("]}");
    }
    return sb.Append(']').ToString();
}

static string Q(string value) => System.Text.Json.JsonSerializer.Serialize(value, JsonOpts.Relaxed);

static class JsonOpts
{
    public static readonly System.Text.Json.JsonSerializerOptions Relaxed = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };
}
