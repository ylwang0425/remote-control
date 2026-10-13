using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

public static partial class WorkBuddyWindowsUiaComProbe
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct ComposerKeyboardInput { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct ComposerMouseInput { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    internal struct ComposerInputUnion {
        [FieldOffset(0)] public ComposerKeyboardInput keyboard;
        [FieldOffset(0)] public ComposerMouseInput mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct ComposerInput { public uint type; public ComposerInputUnion input; }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, ComposerInput[] inputs, int size);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);

    private static ComposerInput ComposerKey(ushort key, ushort scan, uint flags)
    {
        return new ComposerInput { type = 1, input = new ComposerInputUnion {
            keyboard = new ComposerKeyboardInput { key = key, scan = scan, flags = flags }
        } };
    }

    // Only text and Shift+Enter are inserted. Plain Enter never submits a
    // message here; Send remains a separately verified native Invoke action.
    internal static ComposerInput[] BuildComposerInput(string text, bool replaceKnownDraft)
    {
        if (text == null || text.Length == 0 || text.Length > 65536 ||
            text.Any(c => Char.IsControl(c) && c != '\n' && c != '\r' && c != '\t'))
            return new ComposerInput[0];
        List<ComposerInput> events = new List<ComposerInput>();
        if (replaceKnownDraft) {
            events.Add(ComposerKey(0x11, 0, 0)); events.Add(ComposerKey(0x41, 0, 0));
            events.Add(ComposerKey(0x41, 0, 2)); events.Add(ComposerKey(0x11, 0, 2));
        }
        foreach (char c in text.Replace("\r\n", "\n").Replace('\r', '\n')) {
            if (c == '\n') {
                events.Add(ComposerKey(0x10, 0, 0)); events.Add(ComposerKey(0x0D, 0, 0));
                events.Add(ComposerKey(0x0D, 0, 2)); events.Add(ComposerKey(0x10, 0, 2));
            } else {
                // Tab is literal text, not a focus navigation key.
                events.Add(ComposerKey(0, c, 4)); events.Add(ComposerKey(0, c, 6));
            }
        }
        return events.ToArray();
    }

    public sealed class ComposerInputReceipt {
        public bool attempted { get; set; }
        public bool submitted { get; set; }
        public bool draftVerified { get; set; }
        public bool sendEnabled { get; set; }
        public bool targetContextVerified { get; set; }
        public bool foregroundVerified { get; set; }
        public bool conversationIdentityVerified { get; set; }
        public bool newTaskIntentVerified { get; set; }
        public string stage { get; set; }
        public string reason { get; set; }
        public string draftFingerprint { get; set; }
    }

    private static int TypeNativeOtherAnswer(IntPtr hwnd, int pid, string exe, Node node, string text,
        string expectedValue, out bool attempted)
    {
        attempted = false;
        if (node == null || text == null || text.IndexOfAny(new[] { '\r', '\n' }) >= 0 ||
            expectedValue != String.Empty && expectedValue != text || !HelperBudgetReady() ||
            !IsExactPendingTarget(hwnd, pid, exe)) return unchecked((int)0x80070490);
        foreach (int key in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return unchecked((int)0x80070490);
        if (!IsTargetForeground(hwnd)) SetForegroundWindow(hwnd);
        int focused = node.Element.SetFocus();
        if (focused < 0) return focused;
        for (int elapsed = 0; elapsed < 600 && HelperBudgetReady() && !BoolProperty(node.Element, 30008); elapsed += 25) Thread.Sleep(25);
        if (!IsTargetForeground(hwnd) || !BoolProperty(node.Element, 30008) ||
            !IsExactPendingTarget(hwnd, pid, exe) || !HelperBudgetReady() ||
            (Property(node.Element, ValuePropertyId) as string) != expectedValue) return unchecked((int)0x80070490);
        ComposerInput[] input = BuildComposerInput(text, expectedValue.Length > 0);
        if (input.Length == 0) return unchecked((int)0x80070490);
        attempted = true;
        uint sent = SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(ComposerInput)));
        if (sent != input.Length) return unchecked((int)0x80004005);
        for (int elapsed = 0; elapsed < 600 && HelperBudgetReady(); elapsed += 25) {
            if ((Property(node.Element, ValuePropertyId) as string) == text) return 0;
            Thread.Sleep(25);
        }
        return unchecked((int)0x80004005);
    }

    private static bool ComposerContextMatches(Result s, string title, string[][] candidates, int index, string[] knownTitles)
    {
        if (!HasCompleteSnapshotStatus(s)) return false;
        if (title != null) return IsFreshIdentitySnapshot(s, candidates == null ? 0 : candidates.Length, index);
        return knownTitles != null && AnalyzeNewTaskPage(s, knownTitles).verified;
    }

    public static ComposerInputReceipt TypeNativeComposer(IntPtr hwnd, int pid, string exe, string text,
        string expectedDraftFingerprint, string title, string[][] candidates, int index, string[] knownTitles)
    {
        ComposerInputReceipt r = new ComposerInputReceipt { stage = "validate", reason = "input-unverified" };
        string intended = ComposerDraftFingerprint(text, false);
        bool replace = expectedDraftFingerprint != "e3b0c44298fc1c14";
        ComposerInput[] events = BuildComposerInput(text, replace);
        // The phone cannot request arbitrary draft replacement. The adapter
        // normally supplies the empty fingerprint; recovery can replace only
        // a draft equal to this exact requested text after an unsent write.
        if (events.Length == 0 || replace && expectedDraftFingerprint != intended ||
            !HelperBudgetReady() || !IsExactPendingTarget(hwnd, pid, exe)) return r;
        Result s = title == null ? InspectSemantic(hwnd, 5000, 2200) : InspectSemanticIdentity(hwnd, 5000, 2200, title, candidates);
        if (!ComposerContextMatches(s, title, candidates, index, knownTitles)) { r.stage = "conversation-identity"; return r; }
        ControlSummary selector, composer; Node selectorNode, composerNode; int expansion;
        if (!TryGetModelFrame(s, out selector, out selectorNode, out composer, out composerNode, out expansion)) { r.stage = "composer-frame"; return r; }
        if (composer.draftFingerprint != expectedDraftFingerprint) { r.stage = "draft-precondition"; return r; }
        if (expansion == 1) {
            // A catalog read or desktop selection can leave the native portal
            // open. Close that exact selector once before focusing its editor.
            string currentModel = NormalizeModelName(selector.accessibleName);
            ActionResult collapsed = ExecuteSemanticAction(hwnd, pid, "collapse", selector.runtimeIdHash, selector.regionHash,
                "model-selector", composer.draftFingerprint, null, null, null, -1, selector.accessibleName);
            if (!collapsed.submitted) { r.attempted = collapsed.attempted; r.stage = "model-menu-close"; return r; }
            if (HelperBudgetReady()) Thread.Sleep(120);
            s = title == null ? InspectSemantic(hwnd, 5000, 2200) : InspectSemanticIdentity(hwnd, 5000, 2200, title, candidates);
            if (!ComposerContextMatches(s, title, candidates, index, knownTitles) ||
                !TryGetModelFrame(s, out selector, out selectorNode, out composer, out composerNode, out expansion) ||
                expansion != 0 || NormalizeModelName(selector.accessibleName) != currentModel ||
                composer.draftFingerprint != expectedDraftFingerprint) { r.attempted = true; r.stage = "model-menu-close-unconfirmed"; return r; }
        }
        r.conversationIdentityVerified = title != null; r.newTaskIntentVerified = title == null;
        foreach (int key in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) { r.stage = "keyboard-precondition"; return r; }
        r.stage = "focus";
        if (!IsExactPendingTarget(hwnd, pid, exe) || !HelperBudgetReady()) return r;
        if (!IsTargetForeground(hwnd)) SetForegroundWindow(hwnd);
        int focusHr = composerNode.Element.SetFocus();
        if (focusHr < 0) { r.stage = "uia-focus-failed"; r.reason = focusHr.ToString(System.Globalization.CultureInfo.InvariantCulture); return r; }
        // SetFocus submits a Chromium accessibility action asynchronously.
        // Observe that one transition rather than issuing another focus call.
        int focusWaitMs = 0;
        while (!BoolProperty(composerNode.Element, 30008) && focusWaitMs < 600 && HelperBudgetReady()) {
            Thread.Sleep(25); focusWaitMs += 25;
        }
        if (!BoolProperty(composerNode.Element, 30008)) { r.stage = "focus-not-observed"; return r; }
        if (!IsTargetForeground(hwnd) || !IsExactPendingTarget(hwnd, pid, exe)) { r.stage = "focus-target-changed"; return r; }
        string focusedDraft = Property(composerNode.Element, ValuePropertyId) as string;
        if (focusedDraft == null || ComposerDraftFingerprint(focusedDraft, !replace) != expectedDraftFingerprint ||
            RuntimeIdHash(composerNode.Element) != composer.runtimeIdHash || !HelperBudgetReady()) return r;
        r.stage = "text-input"; r.targetContextVerified = true; r.foregroundVerified = true; r.attempted = true;
        uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(ComposerInput)));
        r.submitted = sent == events.Length;
        if (!r.submitted) { r.reason = "partial-input-unknown"; return r; }
        // Await rendering only. There is never a second input attempt.
        while (HelperBudgetReady()) {
            if (!IsExactPendingTarget(hwnd, pid, exe)) { r.reason = "target-changed-after-input"; return r; }
            Result after = title == null ? InspectSemantic(hwnd, 5000, 1600) : InspectSemanticIdentity(hwnd, 5000, 1600, title, candidates);
            if (!ComposerContextMatches(after, title, candidates, index, knownTitles)) { r.reason = "context-changed-after-input"; return r; }
            ControlSummary m, c; Node mn, cn; int es;
            if (TryGetModelFrame(after, out m, out mn, out c, out cn, out es)) {
                r.draftFingerprint = c.draftFingerprint; r.draftVerified = c.draftFingerprint == intended;
                r.sendEnabled = after.controls.Count(v => v.safeActionLabel == "send-label" && v.enabled && v.regionHash == c.regionHash) == 1;
                if (r.draftVerified && r.sendEnabled) { r.stage = "confirmed"; r.reason = null; return r; }
            }
            Thread.Sleep(40);
        }
        r.reason = "editor-state-unconfirmed"; return r;
    }
}
