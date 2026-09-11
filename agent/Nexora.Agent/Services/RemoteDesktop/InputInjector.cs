using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// Mouse and keyboard injection through SendInput.
///
/// This is the only path by which a remote operator affects the machine, and
/// it is deliberately narrow: coordinates are normalised doubles, keys are
/// W3C KeyboardEvent.code names mapped through a fixed table to virtual-key
/// codes, and anything not in that table is dropped. No input value is ever
/// interpreted as text, a path, or a command - there is no code path from a
/// key name to a shell.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class InputInjector(int screenWidth, int screenHeight)
{
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_EXTENDEDKEY = 0x0001;

    /// <summary>
    /// Closed allow-list. A code absent here is ignored rather than guessed at,
    /// so a malformed or hostile key name can never become an arbitrary keystroke.
    /// </summary>
    private static readonly Dictionary<string, ushort> Keys = BuildKeyTable();

    private static Dictionary<string, ushort> BuildKeyTable()
    {
        var map = new Dictionary<string, ushort>(StringComparer.Ordinal);
        for (var c = 'A'; c <= 'Z'; c++) map["Key" + c] = (ushort)c;
        for (var d = 0; d <= 9; d++) map["Digit" + d] = (ushort)('0' + d);
        for (var f = 1; f <= 12; f++) map["F" + f] = (ushort)(0x70 + f - 1);
        foreach (var (name, vk) in new (string, ushort)[]
        {
            ("Escape", 0x1B), ("Tab", 0x09), ("CapsLock", 0x14), ("Space", 0x20), ("Enter", 0x0D), ("NumpadEnter", 0x0D),
            ("Backspace", 0x08), ("Delete", 0x2E), ("Insert", 0x2D), ("Home", 0x24), ("End", 0x23),
            ("PageUp", 0x21), ("PageDown", 0x22), ("ArrowLeft", 0x25), ("ArrowUp", 0x26), ("ArrowRight", 0x27), ("ArrowDown", 0x28),
            ("ShiftLeft", 0xA0), ("ShiftRight", 0xA1), ("ControlLeft", 0xA2), ("ControlRight", 0xA3),
            ("AltLeft", 0xA4), ("AltRight", 0xA5), ("MetaLeft", 0x5B), ("MetaRight", 0x5C),
            ("Minus", 0xBD), ("Equal", 0xBB), ("BracketLeft", 0xDB), ("BracketRight", 0xDD), ("Backslash", 0xDC),
            ("Semicolon", 0xBA), ("Quote", 0xDE), ("Backquote", 0xC0), ("Comma", 0xBC), ("Period", 0xBE), ("Slash", 0xBF),
            ("PrintScreen", 0x2C), ("ScrollLock", 0x91), ("Pause", 0x13), ("NumLock", 0x90),
        }) map[name] = vk;
        return map;
    }

    /// <summary>Keys that must carry the extended-key flag to behave correctly.</summary>
    private static readonly HashSet<string> Extended = new(StringComparer.Ordinal)
    { "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert", "Delete", "ControlRight", "AltRight", "NumpadEnter", "MetaLeft", "MetaRight", "PrintScreen" };

    public int ScreenWidth { get; set; } = Math.Max(1, screenWidth);
    public int ScreenHeight { get; set; } = Math.Max(1, screenHeight);

    /// <summary>Normalised 0..1 to the absolute 0..65535 space SendInput expects.</summary>
    private static int Absolute(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) return 0;
        return (int)Math.Round(Math.Clamp(value, 0d, 1d) * 65535d);
    }

    public bool MoveMouse(double x, double y) => Send(new INPUT
    {
        type = INPUT_MOUSE,
        u = new InputUnion { mi = new MOUSEINPUT { dx = Absolute(x), dy = Absolute(y), dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK } },
    });

    public bool MouseButton(double x, double y, string button, bool pressed)
    {
        var flags = button switch
        {
            "LEFT" => pressed ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP,
            "RIGHT" => pressed ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP,
            "MIDDLE" => pressed ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP,
            _ => 0u,
        };
        if (flags == 0) return false;
        return Send(new INPUT
        {
            type = INPUT_MOUSE,
            u = new InputUnion { mi = new MOUSEINPUT { dx = Absolute(x), dy = Absolute(y), dwFlags = flags | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK } },
        });
    }

    public bool MouseWheel(double x, double y, double deltaY)
    {
        // Browsers report a positive deltaY for scrolling down; Windows expects
        // the opposite sign, in multiples of WHEEL_DELTA (120).
        var notches = (int)Math.Round(Math.Clamp(-deltaY, -10d, 10d) * 120d);
        if (notches == 0) return false;
        return Send(new INPUT
        {
            type = INPUT_MOUSE,
            u = new InputUnion { mi = new MOUSEINPUT { dx = Absolute(x), dy = Absolute(y), mouseData = unchecked((uint)notches), dwFlags = MOUSEEVENTF_WHEEL | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK } },
        });
    }

    public bool Key(string code, bool pressed)
    {
        if (!Keys.TryGetValue(code, out var vk)) return false;
        var flags = pressed ? 0u : KEYEVENTF_KEYUP;
        if (Extended.Contains(code)) flags |= KEYEVENTF_EXTENDEDKEY;
        return Send(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = flags } } });
    }

    public static bool IsKnownKey(string code) => Keys.ContainsKey(code);

    private static bool Send(INPUT input)
    {
        var batch = new[] { input };
        return SendInput(1, batch, Marshal.SizeOf<INPUT>()) == 1;
    }
}
