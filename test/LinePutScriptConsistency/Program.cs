using System.Text;
using LinePutScript;

string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
string fixtures = Path.Combine(root, "test", "fixtures");

foreach (string file in Directory.EnumerateFiles(fixtures, "*.lps").OrderBy(static x => x))
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
