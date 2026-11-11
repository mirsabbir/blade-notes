using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BladeNotes;

/// <summary>
/// Blade Notes for Windows: one window around the web app in WebView2. Its data folder
/// (%LOCALAPPDATA%\BladeNotes) keeps sign-in and offline notes across restarts. Links that
/// leave the app and its sign-in page open in the default browser.
/// </summary>
static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainWindow());
    }
}

sealed class MainWindow : Form
{
    static readonly Uri AppUrl = new(typeof(MainWindow).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(a => a.Key == "AppUrl")?.Value is { Length: > 0 } u ? u : "https://notes.mirsabbiralam.com");
    static readonly string DataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BladeNotes");
    static readonly string BoundsFile = Path.Combine(DataFolder, "window.json");
    readonly WebView2 web = new() { Dock = DockStyle.Fill };

    public MainWindow()
    {
        Text = "Blade Notes";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        MinimumSize = new Size(720, 480);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1360, 860);
        RestoreBounds_();
        Controls.Add(web);
        Load += async (_, _) => await Start();
        FormClosing += OnClosing;
    }

    bool closing;

    /// Closing asks the page first: mid-upload it offers to keep the window open. Then it waits
    /// a moment, so the page's last save reaches disk. Windows shutting down is never held up.
    async void OnClosing(object? sender, FormClosingEventArgs e)
    {
        if (closing || web.CoreWebView2 is null || e.CloseReason == CloseReason.WindowsShutDown)
        {
            SaveBounds();
            return;
        }
        e.Cancel = true;
        var why = JsonSerializer.Deserialize<string?>(await web.CoreWebView2.ExecuteScriptAsync("window.__bladeBusy ? window.__bladeBusy() : null"));
        if (!string.IsNullOrEmpty(why) &&
            MessageBox.Show(this, $"{why}\n\nClose Blade Notes anyway?", "Blade Notes", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            return;
        await Task.Delay(400);
        closing = true;
        Close();
    }

    async Task Start()
    {
        Directory.CreateDirectory(DataFolder);
        var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataFolder, "WebView2"));
        await web.EnsureCoreWebView2Async(env);
        var core = web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.WebMessageReceived += OnMessage;
        core.NavigationStarting += (_, e) =>
        {
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && !IsInternal(uri)) { e.Cancel = true; OpenInBrowser(uri); }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) { if (IsInternal(uri)) core.Navigate(e.Uri); else OpenInBrowser(uri); }
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                core.NavigateToString($"""
                    <body style="font:15px 'Segoe UI';display:grid;place-items:center;height:100vh;margin:0;color:#555e6f">
                    <div style="text-align:center"><p>Can't reach Blade Notes ({e.WebErrorStatus}).</p>
                    <button onclick="location.href='{AppUrl}'" style="font:inherit;padding:6px 14px">Try again</button></div></body>
                    """);
        };
        core.Navigate(AppUrl.AbsoluteUri);
    }

    static bool IsInternal(Uri uri) =>
        uri.Scheme is "about" or "data" or "blob" ||
        uri.Host == AppUrl.Host || uri.Host.EndsWith(".amazoncognito.com", StringComparison.OrdinalIgnoreCase);

    static void OpenInBrowser(Uri uri)
    {
        if (uri.Scheme is "http" or "https" or "mailto") Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    /// <summary>Bridge: messages carry an id; the reply goes back with the same id (see apps/web/src/host.ts).</summary>
    async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
        var root = doc.RootElement;
        var id = root.GetProperty("id").GetInt32();
        var method = root.GetProperty("method").GetString();
        var force = root.TryGetProperty("params", out var p) && p.TryGetProperty("force", out var f) && f.ValueKind == JsonValueKind.True;
        object reply;
        try
        {
            object? result = method switch
            {
                "appInfo" => new Dictionary<string, object?> { ["platform"] = "windows", ["version"] = Updater.Current },
                "checkForUpdate" => await Updater.Check(force),
                "installUpdate" => await InstallAndExit(),
                _ => throw new InvalidOperationException($"unknown method {method}"),
            };
            reply = new { id, result };
        }
        catch (Exception ex)
        {
            reply = new { id, error = ex.Message };
        }
        web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(reply));
    }

    async Task<object?> InstallAndExit()
    {
        await Updater.Install();
        BeginInvoke(Application.Exit);
        return null;
    }

    record SavedBounds(int X, int Y, int W, int H, bool Max);

    void RestoreBounds_()
    {
        try
        {
            var b = JsonSerializer.Deserialize<SavedBounds>(File.ReadAllText(BoundsFile));
            if (b == null) return;
            var rect = new Rectangle(b.X, b.Y, b.W, b.H);
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect))) return;
            StartPosition = FormStartPosition.Manual;
            Bounds = rect;
            if (b.Max) WindowState = FormWindowState.Maximized;
        }
        catch { /* first start, or an unreadable file: use the defaults */ }
    }

    void SaveBounds()
    {
        try
        {
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(BoundsFile, JsonSerializer.Serialize(new SavedBounds(r.X, r.Y, r.Width, r.Height, WindowState == FormWindowState.Maximized)));
        }
        catch { /* not worth failing the close for */ }
    }
}
