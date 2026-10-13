using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

[ComImport, Guid("E22AD333-B25F-460C-83D0-0581107395C9"), ClassInterface(ClassInterfaceType.None)]
internal class WorkBuddyCUIAutomation8 { }

[ComImport, Guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomation
{
    [PreserveSig] int CompareElements(IntPtr first, IntPtr second, [MarshalAs(UnmanagedType.Bool)] out bool same);
    [PreserveSig] int CompareRuntimeIds(IntPtr first, IntPtr second, [MarshalAs(UnmanagedType.Bool)] out bool same);
    [PreserveSig] int GetRootElement(out WorkBuddyIUIAutomationElement root);
    [PreserveSig] int ElementFromHandle(IntPtr hwnd, out WorkBuddyIUIAutomationElement element);
    [PreserveSig] int ElementFromPoint(WorkBuddyPoint point, out WorkBuddyIUIAutomationElement element);
    [PreserveSig] int GetFocusedElement(out WorkBuddyIUIAutomationElement element);
    [PreserveSig] int GetRootElementBuildCache(IntPtr request, out WorkBuddyIUIAutomationElement root);
    [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd, IntPtr request, out WorkBuddyIUIAutomationElement element);
    [PreserveSig] int ElementFromPointBuildCache(WorkBuddyPoint point, IntPtr request, out WorkBuddyIUIAutomationElement element);
    [PreserveSig] int GetFocusedElementBuildCache(IntPtr request, out WorkBuddyIUIAutomationElement element);
    [PreserveSig] int CreateTreeWalker(IntPtr condition, out WorkBuddyIUIAutomationTreeWalker walker);
    [PreserveSig] int get_ControlViewWalker(out WorkBuddyIUIAutomationTreeWalker walker);
    [PreserveSig] int get_ContentViewWalker(out WorkBuddyIUIAutomationTreeWalker walker);
    [PreserveSig] int get_RawViewWalker(out WorkBuddyIUIAutomationTreeWalker walker);
}

[ComImport, Guid("4042C624-389C-4AFC-A630-9DF854A541FC"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomationTreeWalker
{
    [PreserveSig] int GetParentElement(WorkBuddyIUIAutomationElement element, out WorkBuddyIUIAutomationElement parent);
    [PreserveSig] int GetFirstChildElement(WorkBuddyIUIAutomationElement element, out WorkBuddyIUIAutomationElement child);
    [PreserveSig] int GetLastChildElement(WorkBuddyIUIAutomationElement element, out WorkBuddyIUIAutomationElement child);
    [PreserveSig] int GetNextSiblingElement(WorkBuddyIUIAutomationElement element, out WorkBuddyIUIAutomationElement sibling);
    [PreserveSig] int GetPreviousSiblingElement(WorkBuddyIUIAutomationElement element, out WorkBuddyIUIAutomationElement sibling);
    [PreserveSig] int NormalizeElement(WorkBuddyIUIAutomationElement element, out WorkBuddyIUIAutomationElement normalized);
    [PreserveSig] int GetParentElementBuildCache(WorkBuddyIUIAutomationElement element, IntPtr request, out WorkBuddyIUIAutomationElement parent);
    [PreserveSig] int GetFirstChildElementBuildCache(WorkBuddyIUIAutomationElement element, IntPtr request, out WorkBuddyIUIAutomationElement child);
    [PreserveSig] int GetLastChildElementBuildCache(WorkBuddyIUIAutomationElement element, IntPtr request, out WorkBuddyIUIAutomationElement child);
    [PreserveSig] int GetNextSiblingElementBuildCache(WorkBuddyIUIAutomationElement element, IntPtr request, out WorkBuddyIUIAutomationElement sibling);
    [PreserveSig] int GetPreviousSiblingElementBuildCache(WorkBuddyIUIAutomationElement element, IntPtr request, out WorkBuddyIUIAutomationElement sibling);
    [PreserveSig] int NormalizeElementBuildCache(WorkBuddyIUIAutomationElement element, IntPtr request, out WorkBuddyIUIAutomationElement normalized);
    [PreserveSig] int get_Condition(out IntPtr condition);
}

[ComImport, Guid("D22108AA-8AC5-49A5-837B-37BBB3D7591E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomationElement
{
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId(out IntPtr runtimeId);
    [PreserveSig] int FindFirst(int scope, IntPtr condition, out IntPtr element);
    [PreserveSig] int FindAll(int scope, IntPtr condition, out IntPtr elements);
    [PreserveSig] int FindFirstBuildCache(int scope, IntPtr condition, IntPtr request, out IntPtr element);
    [PreserveSig] int FindAllBuildCache(int scope, IntPtr condition, IntPtr request, out IntPtr elements);
    [PreserveSig] int BuildUpdatedCache(IntPtr request, out IntPtr element);
    [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int GetCurrentPropertyValueEx(int propertyId, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int GetCachedPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int GetCachedPropertyValueEx(int propertyId, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault, [MarshalAs(UnmanagedType.Struct)] out object value);
    [PreserveSig] int GetCurrentPatternAs(int patternId, ref Guid iid, out IntPtr pattern);
    [PreserveSig] int GetCachedPatternAs(int patternId, ref Guid iid, out IntPtr pattern);
    [PreserveSig] int GetCurrentPattern(int patternId, [MarshalAs(UnmanagedType.Interface)] out object pattern);
}

[ComImport, Guid("FB377FBE-8EA6-46D5-9C73-6499642D3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomationInvokePattern
{
    [PreserveSig] int Invoke();
}

[ComImport, Guid("A94CD8B1-0844-4CD6-9D2D-640537AB39E9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomationValuePattern
{
    [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string value);
    [PreserveSig] int get_CurrentValue([MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_CurrentIsReadOnly([MarshalAs(UnmanagedType.Bool)] out bool readOnly);
    [PreserveSig] int get_CachedValue([MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_CachedIsReadOnly([MarshalAs(UnmanagedType.Bool)] out bool readOnly);
}

[ComImport, Guid("619BE086-1F4E-4EE4-BAFA-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomationExpandCollapsePattern
{
    [PreserveSig] int Expand();
    [PreserveSig] int Collapse();
    [PreserveSig] int get_CurrentExpandCollapseState(out int state);
    [PreserveSig] int get_CachedExpandCollapseState(out int state);
}

[ComImport, Guid("A8EFA66A-0FDA-421A-9194-38021F3578EA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface WorkBuddyIUIAutomationSelectionItemPattern
{
    [PreserveSig] int Select();
    [PreserveSig] int AddToSelection();
    [PreserveSig] int RemoveFromSelection();
    [PreserveSig] int get_CurrentIsSelected([MarshalAs(UnmanagedType.Bool)] out bool selected);
    [PreserveSig] int get_CurrentSelectionContainer([MarshalAs(UnmanagedType.Interface)] out object container);
    [PreserveSig] int get_CachedIsSelected([MarshalAs(UnmanagedType.Bool)] out bool selected);
    [PreserveSig] int get_CachedSelectionContainer([MarshalAs(UnmanagedType.Interface)] out object container);
}

[StructLayout(LayoutKind.Sequential)]
internal struct WorkBuddyPoint { public int X; public int Y; }

public static partial class WorkBuddyWindowsUiaComProbe
{
    private static Stopwatch helperBudgetClock;
    private static int helperBudgetRemainingMs;

    public static void StartHelperBudget(int remainingMilliseconds)
    {
        helperBudgetRemainingMs = Math.Max(0, Math.Min(15000, remainingMilliseconds));
        helperBudgetClock = Stopwatch.StartNew();
    }

    private static bool HelperBudgetReady()
    {
        Stopwatch clock = helperBudgetClock;
        return clock == null || clock.ElapsedMilliseconds < helperBudgetRemainingMs;
    }

    public sealed class ControlSummary
    {
        public int depth { get; set; }
        public int index { get; set; }
        public string controlType { get; set; }
        public int controlTypeId { get; set; }
        public string accessibleName { get; set; }
        public bool enabled { get; set; }
        public bool offscreen { get; set; }
        public bool selected { get; set; }
        public bool focusable { get; set; }
        public string safeActionLabel { get; set; }
        public string identityRole { get; set; }
        public string draftState { get; set; }
        public string draftFingerprint { get; set; }
        public string[] patterns { get; set; }
        public int expandCollapseState { get; set; }
        public string pathHash { get; set; }
        public string runtimeIdHash { get; set; }
        public string regionHash { get; set; }
        public bool passwordProtected { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
    }

    public sealed class Status
    {
        public bool comActivated { get; set; }
        public int activationHresult { get; set; }
        public int elementFromHandleHresult { get; set; }
        public int rawWalkerHresult { get; set; }
        public int rootControlTypeId { get; set; }
        public bool uiaWindowRootRetrieved { get; set; }
        public int providerDescriptionQueryHresult { get; set; }
        public string providerDescriptionClass { get; set; }
        public int providerClassQueryCount { get; set; }
        public string[] providerClassHistogram { get; set; }
        public bool legacyIAccessiblePatternAvailable { get; set; }
        public int legacyIAccessiblePatternQueryHresult { get; set; }
        public int legacyIAccessiblePatternNodes { get; set; }
        public int traversedNodes { get; set; }
        public bool traversalTruncated { get; set; }
        public bool composerBindingAttempted { get; set; }
        public bool composerBindingSucceeded { get; set; }
        public int composerEditCandidates { get; set; }
        public int composerModelCandidates { get; set; }
        public int composerSendCandidates { get; set; }
        public int composerGroupDepth { get; set; }
        public int composerGroupTypeId { get; set; }
        public int elapsedMs { get; set; }
        public string[] typeHistogram { get; set; }
        public string errorType { get; set; }
        public string errorStage { get; set; }
    }

    public sealed class Result
    {
        public Status status { get; set; }
        public ControlSummary[] controls { get; set; }
        public ConversationIdentityProof identityProof { get; set; }
        internal Node[] NodeReferences { get; set; }
        internal Node[] AllNodeReferences { get; set; }
        internal Dictionary<string, int> NodeTypeByPath { get; set; }
    }

    public sealed class ConversationIdentityProof
    {
        public int conversationRowMatches { get; set; }
        public int conversationHeaderMatches { get; set; }
        public int candidateCount { get; set; }
        public int matchedCandidateIndex { get; set; }
    }

    public sealed class NewTaskPageProof
    {
        public bool snapshotComplete { get; set; }
        public bool verified { get; set; }
        public int selectedNewTaskTabCount { get; set; }
        public int selectedConversationTabMatches { get; set; }
        public int conversationHeaderMatches { get; set; }
        public int visibleWelcomeMarkerMatches { get; set; }
        public int composerDocumentWelcomeMarkerMatches { get; set; }
        public int homePageAncestorMatches { get; set; }
        public int homeComposerAncestorMatches { get; set; }
        public int homeRouteInputAncestorMatches { get; set; }
        public string composerDocumentRegionHash { get; set; }
        public int composerDocumentTextSampleCount { get; set; }
        public string[] composerDocumentTextSamples { get; set; }
        public int composerAncestorCount { get; set; }
        public NewTaskPageAncestor[] composerAncestors { get; set; }
    }

    public sealed class NewTaskPageAncestor
    {
        public int depth { get; set; }
        public int controlTypeId { get; set; }
        public string accessibleName { get; set; }
        public string automationId { get; set; }
        public string className { get; set; }
        public string ariaRole { get; set; }
        public string pathHash { get; set; }
        public string runtimeIdHash { get; set; }
        public string regionHash { get; set; }
    }

    public sealed class ActionResult
    {
        public string operation { get; set; }
        public bool attempted { get; set; }
        public bool submitted { get; set; }
        public bool conversationIdentityVerified { get; set; }
        public bool newTaskIntentVerified { get; set; }
        public bool targetContextVerified { get; set; }
        public bool foregroundVerified { get; set; }
        public string newTaskNavigationSource { get; set; }
        public int hresult { get; set; }
        public string stage { get; set; }
        public int matchingControls { get; set; }
    }

    public sealed class ModelCatalogResult
    {
        public string outcome { get; set; }
        public string reason { get; set; }
        public bool targetContextVerified { get; set; }
        public string currentModel { get; set; }
        public string[] models { get; set; }
        public string initialDraftFingerprint { get; set; }
        public string finalDraftFingerprint { get; set; }
        public bool composerVerified { get; set; }
        public bool initiallyExpanded { get; set; }
        public bool finallyExpanded { get; set; }
        public ModelMenuDiagnostic modelMenu { get; set; }
        public ActionResult[] patternReceipts { get; set; }
    }

    public sealed class ModelMenuDiagnostic
    {
        public string association { get; set; }
        public int newVisiblePopupRootCount { get; set; }
        public int selectedCurrentModelCount { get; set; }
        public ModelMenuControl[] controls { get; set; }
    }

    public sealed class ModelMenuControl
    {
        public int depthWithinPopup { get; set; }
        public string controlType { get; set; }
        public int controlTypeId { get; set; }
        public string accessibleName { get; set; }
        public bool enabled { get; set; }
        public bool offscreen { get; set; }
        public bool selected { get; set; }
        public bool passwordProtected { get; set; }
        public string[] patterns { get; set; }
        public string pathHash { get; set; }
        public string runtimeIdHash { get; set; }
        public string regionHash { get; set; }
    }

    internal sealed class Node
    {
        public WorkBuddyIUIAutomationElement Element;
        public int Depth;
        public int Index;
        public string Path;
        public string RegionPath;
    }

    private const int ControlTypePropertyId = 30003;
    private const int NamePropertyId = 30005;
    private const int EnabledPropertyId = 30010;
    private const int IsPasswordPropertyId = 30019;
    private const int OffscreenPropertyId = 30022;
    private const int FocusablePropertyId = 30009;
    private const int SelectedPropertyId = 30079;
    private const int ValuePropertyId = 30045;
    private const int BoundingRectanglePropertyId = 30001;
    private const int InvokePatternId = 10000;
    private const int ValuePatternId = 10002;
    private const int ExpandCollapsePatternId = 10005;
    private const int SelectionItemPatternId = 10010;
    private const int TextPatternId = 10014;
    private const int TogglePatternId = 10015;
    private const int LegacyIAccessiblePatternId = 10018;
    private const int ProviderDescriptionPropertyId = 30107;
    private const int AutomationIdPropertyId = 30011;
    private const int ClassNamePropertyId = 30012;
    private const int AriaRolePropertyId = 30101;

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, uint length, out uint needed);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);

    private static bool NativeActionTargetReady(IntPtr hwnd, int expectedProcessId)
    {
        try
        {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if (processId != (uint)expectedProcessId || !IsWindowVisible(hwnd) ||
                !IsWindowEnabled(hwnd) || IsIconic(hwnd)) return false;
            IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
            if (desktop == IntPtr.Zero) return false;
            try
            {
                StringBuilder name = new StringBuilder(256);
                uint needed;
                return GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out needed) &&
                    String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            }
            finally { CloseDesktop(desktop); }
        }
        catch { return false; }
    }

    private static bool IsTargetForeground(IntPtr hwnd)
    {
        try { return GetForegroundWindow() == hwnd; }
        catch { return false; }
    }

    [DllImport("oleaut32.dll", PreserveSig=true)] private static extern uint SafeArrayGetDim(IntPtr array);
    [DllImport("oleaut32.dll", PreserveSig=true)] private static extern int SafeArrayGetLBound(IntPtr array, uint dimension, out int lowerBound);
    [DllImport("oleaut32.dll", PreserveSig=true)] private static extern int SafeArrayGetUBound(IntPtr array, uint dimension, out int upperBound);
    [DllImport("oleaut32.dll", PreserveSig=true)] private static extern int SafeArrayGetElement(IntPtr array, ref int index, out int value);
    [DllImport("oleaut32.dll", PreserveSig=true)] private static extern int SafeArrayDestroy(IntPtr array);

    private static string RuntimeIdHash(WorkBuddyIUIAutomationElement element)
    {
        IntPtr array = IntPtr.Zero;
        try
        {
            int hr = element.GetRuntimeId(out array);
            if (hr < 0 || array == IntPtr.Zero || SafeArrayGetDim(array) != 1) return String.Empty;
            int lower, upper;
            if (SafeArrayGetLBound(array, 1, out lower) < 0 || SafeArrayGetUBound(array, 1, out upper) < 0 || upper < lower || upper - lower > 63)
                return String.Empty;
            StringBuilder serialized = new StringBuilder();
            for (int index = lower; index <= upper; index++)
            {
                int value;
                int elementIndex = index;
                if (SafeArrayGetElement(array, ref elementIndex, out value) < 0) return String.Empty;
                if (serialized.Length > 0) serialized.Append(',');
                serialized.Append(value.ToString(CultureInfo.InvariantCulture));
            }
            return Hash(serialized.ToString());
        }
        catch { return String.Empty; }
        finally { if (array != IntPtr.Zero) { try { SafeArrayDestroy(array); } catch { } } }
    }

    private static object Property(WorkBuddyIUIAutomationElement element, int propertyId)
    {
        object value;
        int hr = element.GetCurrentPropertyValue(propertyId, out value);
        return hr >= 0 ? value : null;
    }

    private static bool BoolProperty(WorkBuddyIUIAutomationElement element, int propertyId)
    {
        object value = Property(element, propertyId);
        return value is bool && (bool)value;
    }

    private static bool HasPattern(WorkBuddyIUIAutomationElement element, int patternId)
    {
        object pattern = null;
        try
        {
            int hr = element.GetCurrentPattern(patternId, out pattern);
            return hr >= 0 && pattern != null;
        }
        catch { return false; }
        finally
        {
            if (pattern != null && Marshal.IsComObject(pattern))
            {
                try { Marshal.ReleaseComObject(pattern); } catch { }
            }
        }
    }

    private static int ProbePattern(WorkBuddyIUIAutomationElement element, int patternId, out bool available)
    {
        available = false;
        object pattern = null;
        try
        {
            int hr = element.GetCurrentPattern(patternId, out pattern);
            available = hr >= 0 && pattern != null;
            return hr;
        }
        catch { return unchecked((int)0x80004005); }
        finally
        {
            if (pattern != null && Marshal.IsComObject(pattern))
            {
                try { Marshal.ReleaseComObject(pattern); } catch { }
            }
        }
    }

    // ProviderDescription can contain arbitrary package paths and provider
    // details. Return only fixed categories; never serialize the raw string.
    private static string ClassifyProviderDescription(object value)
    {
        string description = value as string;
        if (String.IsNullOrWhiteSpace(description)) return "empty";
        if (description.IndexOf("chrom", StringComparison.OrdinalIgnoreCase) >= 0 ||
            description.IndexOf("electron", StringComparison.OrdinalIgnoreCase) >= 0) return "chromium-provider";
        if (description.IndexOf("uiautomationcore", StringComparison.OrdinalIgnoreCase) >= 0) return "windows-uia-proxy";
        if (description.IndexOf("oleacc", StringComparison.OrdinalIgnoreCase) >= 0 ||
            description.IndexOf("msaa", StringComparison.OrdinalIgnoreCase) >= 0) return "windows-msaa-proxy";
        if (description.IndexOf("win32", StringComparison.OrdinalIgnoreCase) >= 0) return "win32-provider";
        return "other-provider";
    }

    private static int QueryProviderDescription(WorkBuddyIUIAutomationElement element, out string providerClass)
    {
        providerClass = "empty";
        object value = null;
        try
        {
            int hr = element.GetCurrentPropertyValue(ProviderDescriptionPropertyId, out value);
            if (hr >= 0) providerClass = ClassifyProviderDescription(value);
            return hr;
        }
        catch { return unchecked((int)0x80004005); }
        finally
        {
            value = null;
        }
    }

    private static string SafeName(object value)
    {
        string text = value as string;
        if (String.IsNullOrEmpty(text) || text.Length > 256) return String.Empty;
        text = System.Text.RegularExpressions.Regex.Replace(text, @"(?i)\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*", "$1[REDACTED]");
        text = System.Text.RegularExpressions.Regex.Replace(text, @"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)([\""'`]?\s*[:=]\s*[\""'`]?)[^\s\""'``,;]+", "$1$2[REDACTED]");
        text = System.Text.RegularExpressions.Regex.Replace(text, @"[\r\n\p{Cc}]", " ").Trim();
        return text.Length <= 256 ? text : String.Empty;
    }

    private static string SafeMessageAnchorText(object value)
    {
        string text = value as string;
        if (String.IsNullOrWhiteSpace(text) || text.Length > 20000) return String.Empty;
        string cleaned = System.Text.RegularExpressions.Regex.Replace(text, @"[\r\n\p{Z}\p{Cc}]+", " ").Trim();
        if (System.Text.RegularExpressions.Regex.IsMatch(cleaned,
            @"(?i)\b(?:Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})")) return String.Empty;
        return cleaned.Length <= 240 ? cleaned : cleaned.Substring(cleaned.Length - 240);
    }

    private static string ConversationRowTitle(string value)
    {
        string text = SafeName(value);
        if (String.IsNullOrEmpty(text)) return String.Empty;
        System.Text.RegularExpressions.Match match = System.Text.RegularExpressions.Regex.Match(text,
            @"\s+(?:刚刚|昨天|前天|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|just\s+now|yesterday|today|\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        if (!match.Success || match.Index <= 0) return String.Empty;
        string title = text.Substring(0, match.Index).Trim();
        return title.Length > 0 && title.Length <= 180 && title.IndexOf("[REDACTED]", StringComparison.OrdinalIgnoreCase) < 0
            ? title : String.Empty;
    }

    private static string TypeName(int typeId)
    {
        switch (typeId)
        {
            case 50000: return "ControlType.Button";
            case 50003: return "ControlType.ComboBox";
            case 50004: return "ControlType.Edit";
            case 50007: return "ControlType.ListItem";
            case 50018: return "ControlType.Tab";
            case 50019: return "ControlType.TabItem";
            case 50020: return "ControlType.Text";
            case 50030: return "ControlType.Document";
            default: return String.Empty;
        }
    }

    private static string DiagnosticTypeName(int typeId)
    {
        switch (typeId)
        {
            case 50000: return "ControlType.Button";
            case 50001: return "ControlType.Calendar";
            case 50002: return "ControlType.CheckBox";
            case 50003: return "ControlType.ComboBox";
            case 50004: return "ControlType.Edit";
            case 50005: return "ControlType.Hyperlink";
            case 50006: return "ControlType.Image";
            case 50007: return "ControlType.ListItem";
            case 50008: return "ControlType.List";
            case 50009: return "ControlType.Menu";
            case 50010: return "ControlType.MenuBar";
            case 50011: return "ControlType.MenuItem";
            case 50012: return "ControlType.ProgressBar";
            case 50013: return "ControlType.RadioButton";
            case 50014: return "ControlType.ScrollBar";
            case 50015: return "ControlType.Slider";
            case 50016: return "ControlType.Spinner";
            case 50017: return "ControlType.StatusBar";
            case 50018: return "ControlType.Tab";
            case 50019: return "ControlType.TabItem";
            case 50020: return "ControlType.Text";
            case 50021: return "ControlType.ToolBar";
            case 50022: return "ControlType.ToolTip";
            case 50023: return "ControlType.Tree";
            case 50024: return "ControlType.TreeItem";
            case 50025: return "ControlType.Custom";
            case 50026: return "ControlType.Group";
            case 50027: return "ControlType.Thumb";
            case 50028: return "ControlType.DataGrid";
            case 50029: return "ControlType.DataItem";
            case 50030: return "ControlType.Document";
            case 50031: return "ControlType.SplitButton";
            case 50032: return "ControlType.Window";
            case 50033: return "ControlType.Pane";
            case 50034: return "ControlType.Header";
            case 50035: return "ControlType.HeaderItem";
            case 50036: return "ControlType.Table";
            case 50037: return "ControlType.TitleBar";
            case 50038: return "ControlType.Separator";
            case 50039: return "ControlType.SemanticZoom";
            case 50040: return "ControlType.AppBar";
            default: return "ControlType.Unknown";
        }
    }

    private static string SafeAction(string controlType, string name)
    {
        string text = (name ?? String.Empty).Trim().ToLowerInvariant();
        if (controlType == "ControlType.Button")
        {
            if (text == "send" || text == "发送") return "send-label";
            if (text == "stop" || text == "停止" || text == "interrupt" || text == "中断") return "stop-label";
            if (text == "new chat" || text == "new conversation" || text == "新建会话" || text == "开始新的对话") return "new-chat-label";
            if (text == "new task" || text == "新建任务" || text == "新任务") return "new-task-label";
            if (text == "allow once" || text == "allow this time" || text == "仅此一次允许" || text == "仅本次允许") return "allow-once-label";
            if (text == "reject" || text == "deny" || text == "拒绝") return "reject-label";
            if (text == "answer" || text == "submit" || text == "continue" || text == "回答" || text == "提交" || text == "继续") return "answer-label";
        }
        if (controlType == "ControlType.TabItem" &&
            (text == "new task" || text == "新建任务" || text == "新任务")) return "new-task-tab";
        return String.Empty;
    }

    private static bool IsSafeCatalogLabel(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length > 180 || value.IndexOf('\0') >= 0) return false;
        string lower = value.ToLowerInvariant();
        return lower.IndexOf("password", StringComparison.Ordinal) < 0 && lower.IndexOf("token", StringComparison.Ordinal) < 0 &&
            lower.IndexOf("secret", StringComparison.Ordinal) < 0 && lower.IndexOf("authorization", StringComparison.Ordinal) < 0;
    }

    private static ControlSummary SummarizeCatalogOption(Node node, string safeActionLabel, string regionHash)
    {
        if (node == null || node.Element == null) return null;
        string name = SafeName(Property(node.Element, NamePropertyId));
        if (!IsSafeCatalogLabel(name)) return null;
        bool password = BoolProperty(node.Element, IsPasswordPropertyId);
        if (password) return null;
        List<string> patterns = new List<string>();
        AddPattern(patterns, node.Element, SelectionItemPatternId, "selectionItem");
        return new ControlSummary
        {
            depth = node.Depth, index = node.Index, controlType = "ControlType.ListItem", controlTypeId = 50007,
            accessibleName = name, enabled = BoolProperty(node.Element, EnabledPropertyId),
            offscreen = BoolProperty(node.Element, OffscreenPropertyId), selected = BoolProperty(node.Element, SelectedPropertyId),
            focusable = BoolProperty(node.Element, FocusablePropertyId), safeActionLabel = safeActionLabel,
            draftState = "unavailable", draftFingerprint = String.Empty, patterns = patterns.ToArray(),
            pathHash = Hash(node.Path), runtimeIdHash = RuntimeIdHash(node.Element), regionHash = regionHash,
            passwordProtected = false, x = 0, y = 0, width = 0, height = 0
        };
    }

    private static string Hash(string text)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(text ?? String.Empty));
            return BitConverter.ToString(bytes).Replace("-", String.Empty).Substring(0, 16).ToLowerInvariant();
        }
    }

    private static string NormalizeComposerDraft(string value, bool sendDisabled)
    {
        string draft = (value ?? String.Empty).TrimStart('\uFEFF').Trim();
        if (draft.Length == 0) return String.Empty;
        if (sendDisabled && (String.Equals(draft, "今天帮你做些什么？@ 添加上下文，/调用技能与指令", StringComparison.Ordinal) ||
            String.Equals(draft, "今天帮你做些什么？@添加上下文，/调用技能与指令", StringComparison.Ordinal) ||
            String.Equals(draft, "What can I help you with?", StringComparison.Ordinal))) return String.Empty;
        return draft;
    }

    // Shared by the live UIA path and a compile-time PowerShell fixture. The
    // helper intentionally treats only WorkBuddy's exact known placeholders
    // as empty; real user text remains fingerprinted byte-for-byte after trim.
    public static string ComposerDraftFingerprint(string value, bool sendDisabled)
    {
        return Hash(NormalizeComposerDraft(value, sendDisabled));
    }

    private static void AddPattern(List<string> patterns, WorkBuddyIUIAutomationElement element, int id, string name)
    {
        if (HasPattern(element, id)) patterns.Add(name);
    }

    private static int CurrentExpandCollapseState(WorkBuddyIUIAutomationElement element)
    {
        object rawPattern = null;
        try
        {
            int hr = element.GetCurrentPattern(ExpandCollapsePatternId, out rawPattern);
            WorkBuddyIUIAutomationExpandCollapsePattern pattern = rawPattern as WorkBuddyIUIAutomationExpandCollapsePattern;
            int state;
            if (hr < 0 || pattern == null || pattern.get_CurrentExpandCollapseState(out state) < 0) return -1;
            return state == 0 || state == 1 ? state : -1;
        }
        catch { return -1; }
        finally { if (rawPattern != null && Marshal.IsComObject(rawPattern)) { try { Marshal.ReleaseComObject(rawPattern); } catch { } } }
    }

    private static ControlSummary Summarize(Node node, bool allowContext, bool lightweight)
    {
        int typeId = 0;
        try { typeId = Convert.ToInt32(Property(node.Element, ControlTypePropertyId), CultureInfo.InvariantCulture); } catch { }
        string type = TypeName(typeId);
        if (String.IsNullOrEmpty(type)) return null;
        bool password = type == "ControlType.Edit" && BoolProperty(node.Element, IsPasswordPropertyId);
        bool selected = (type == "ControlType.ListItem" || type == "ControlType.TabItem") && BoolProperty(node.Element, SelectedPropertyId);
        string name = String.Empty;
        if (allowContext && !password && (selected || type == "ControlType.ComboBox"))
            name = SafeName(Property(node.Element, NamePropertyId));
        if (allowContext && type == "ControlType.TabItem")
        {
            string tabName = SafeName(Property(node.Element, NamePropertyId));
            string normalizedTab = (tabName ?? String.Empty).Trim().ToLowerInvariant();
            if (normalizedTab == "项目" || normalizedTab == "projects" || normalizedTab == "新建任务" || normalizedTab == "新任务" || normalizedTab == "new task")
                name = tabName;
            else if (!selected) name = String.Empty;
        }
        string safeAction = String.Empty;
        if (allowContext && type == "ControlType.TabItem") safeAction = SafeAction(type, name);
        if (allowContext && type == "ControlType.Button")
        {
            string buttonName = SafeName(Property(node.Element, NamePropertyId));
            safeAction = SafeAction(type, buttonName);
            if (!String.IsNullOrEmpty(safeAction)) name = buttonName;
        }
        if (allowContext && !password && type == "ControlType.ComboBox")
        {
            string comboName = SafeName(Property(node.Element, NamePropertyId));
            if (comboName.StartsWith("Select model:", StringComparison.OrdinalIgnoreCase) || comboName.StartsWith("选择模型：", StringComparison.Ordinal))
            {
                name = comboName;
                safeAction = "model-selector";
            }
            else if (comboName.IndexOf("工作空间", StringComparison.Ordinal) >= 0 || comboName.IndexOf("workspace", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                name = comboName;
                safeAction = "workspace-selector";
            }
            else name = String.Empty;
        }
        if (lightweight && password) return null;
        if (lightweight && String.IsNullOrEmpty(safeAction) && type != "ControlType.Edit" &&
            !(type == "ControlType.TabItem" && selected && !String.IsNullOrEmpty(name))) return null;
        string runtimeIdHash = String.Empty;
        if (allowContext && !password && (!String.IsNullOrEmpty(safeAction) || selected || type == "ControlType.Edit"))
            runtimeIdHash = RuntimeIdHash(node.Element);

        string draftState = "unavailable";
        string draftFingerprint = String.Empty;
        List<string> patterns = new List<string>();
        if (!lightweight || type == "ControlType.Button") AddPattern(patterns, node.Element, InvokePatternId, "invoke");
        if (!lightweight || safeAction == "model-selector" || safeAction == "workspace-selector" || type == "ControlType.Edit") AddPattern(patterns, node.Element, ValuePatternId, "value");
        if (!lightweight || safeAction == "model-selector" || safeAction == "workspace-selector") AddPattern(patterns, node.Element, ExpandCollapsePatternId, "expandCollapse");
        if (!lightweight || (type == "ControlType.TabItem" && (selected || safeAction == "new-task-tab"))) AddPattern(patterns, node.Element, SelectionItemPatternId, "selectionItem");
        if (!lightweight || type == "ControlType.Edit") AddPattern(patterns, node.Element, TextPatternId, "text");
        if (!lightweight) AddPattern(patterns, node.Element, TogglePatternId, "toggle");

        object rectValue = Property(node.Element, BoundingRectanglePropertyId);
        Array rect = rectValue as Array;
        int x = 0, y = 0, width = 0, height = 0;
        if (rect != null && rect.Length >= 4)
        {
            try
            {
                x = Convert.ToInt32(Math.Round(Convert.ToDouble(rect.GetValue(0), CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
                y = Convert.ToInt32(Math.Round(Convert.ToDouble(rect.GetValue(1), CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
                // UIA_BoundingRectanglePropertyId is a UiaRect SAFEARRAY
                // [left, top, width, height]. This differs from Win32 RECT,
                // whose last two fields are right and bottom.
                width = Math.Max(0, Convert.ToInt32(Math.Round(Convert.ToDouble(rect.GetValue(2), CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture));
                height = Math.Max(0, Convert.ToInt32(Math.Round(Convert.ToDouble(rect.GetValue(3), CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture));
            }
            catch { x = y = width = height = 0; }
        }

        return new ControlSummary
        {
            depth = node.Depth,
            index = node.Index,
            controlType = type,
            controlTypeId = typeId,
            accessibleName = name,
            enabled = BoolProperty(node.Element, EnabledPropertyId),
            offscreen = BoolProperty(node.Element, OffscreenPropertyId),
            selected = selected,
            focusable = BoolProperty(node.Element, FocusablePropertyId),
            safeActionLabel = safeAction,
            draftState = draftState,
            draftFingerprint = draftFingerprint,
            patterns = patterns.ToArray(),
            expandCollapseState = safeAction == "model-selector" ? CurrentExpandCollapseState(node.Element) : -1,
            pathHash = Hash(node.Path),
            runtimeIdHash = runtimeIdHash,
            regionHash = Hash(String.IsNullOrEmpty(node.RegionPath) ? "root" : node.RegionPath),
            passwordProtected = password,
            x = x, y = y, width = width, height = height
        };
    }

    private static void ReadBoundComposerDraft(ControlSummary summary, Node node, bool sendDisabled)
    {
        if (summary == null || node == null || summary.passwordProtected) return;
        object value = Property(node.Element, ValuePropertyId);
        if (!(value is string)) return;
        string draft = NormalizeComposerDraft((string)value, sendDisabled);
        bool empty = draft.Length == 0;
        summary.safeActionLabel = "composer";
        summary.accessibleName = "composer";
        summary.draftState = empty ? "empty" : "non-empty";
        summary.draftFingerprint = Hash(draft);
    }

    private static string CommonAncestorPath(string first, string second, string third, out int depth)
    {
        depth = -1;
        if (String.IsNullOrEmpty(first) || String.IsNullOrEmpty(second) || String.IsNullOrEmpty(third)) return String.Empty;
        string[] a = first.Split('/');
        string[] b = second.Split('/');
        string[] c = third.Split('/');
        int count = Math.Min(a.Length, Math.Min(b.Length, c.Length));
        int shared = 0;
        while (shared < count && a[shared] == b[shared] && a[shared] == c[shared]) shared++;
        if (shared == 0) return String.Empty;
        depth = shared - 1;
        return String.Join("/", a, 0, shared);
    }

    public static Result Inspect(IntPtr hwnd, int maxControls, bool allowContext, int maxNodes, int timeBudgetMs)
    {
        return InspectInternal(hwnd, maxControls, allowContext, maxNodes, timeBudgetMs, false, null, null);
    }

    public static Result InspectSemantic(IntPtr hwnd, int maxNodes, int timeBudgetMs)
    {
        return InspectInternal(hwnd, 256, true, maxNodes, timeBudgetMs, true, null, null);
    }

    public static Result InspectSemanticIdentity(IntPtr hwnd, int maxNodes, int timeBudgetMs, string title, string[][] candidateAnchors)
    {
        if (String.IsNullOrWhiteSpace(title) || title.Length > 180 || candidateAnchors == null ||
            candidateAnchors.Length < 1 || candidateAnchors.Length > 64 ||
            candidateAnchors.Any(candidate => candidate == null || candidate.Length > 3))
            return new Result { status = new Status { traversalTruncated = true }, controls = new ControlSummary[0] };
        string[][] normalized = candidateAnchors.Select(candidate => candidate.Select(value => value == null
            ? String.Empty : System.Text.RegularExpressions.Regex.Replace(value, @"[\r\n\p{Z}\p{Cc}]+", " ").Trim()).ToArray()).ToArray();
        if (normalized.SelectMany(candidate => candidate).Any(value => value.Length < 2 || value.Length > 120 ||
            System.Text.RegularExpressions.Regex.IsMatch(value, @"(?i)\b(?:Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})")))
            return new Result { status = new Status { traversalTruncated = true }, controls = new ControlSummary[0] };
        return InspectInternal(hwnd, 256, true, maxNodes, timeBudgetMs, true, title, normalized);
    }

    private static bool IsNewTaskWelcomeMarker(string value)
    {
        return String.Equals(value, "内容由 AI 生成，请核实重要信息", StringComparison.Ordinal) ||
            String.Equals(value, "AI-generated content. Please verify important information.", StringComparison.Ordinal);
    }

    private static string NearestDocumentAncestorPath(Result snapshot, string nodePath)
    {
        if (snapshot == null || snapshot.NodeTypeByPath == null || String.IsNullOrEmpty(nodePath)) return String.Empty;
        string[] parts = nodePath.Split('/');
        for (int length = parts.Length; length > 0; length--)
        {
            string candidatePath = String.Join("/", parts, 0, length);
            int typeId;
            if (snapshot.NodeTypeByPath.TryGetValue(candidatePath, out typeId) && typeId == 50030)
                return candidatePath;
        }
        return String.Empty;
    }

    private static bool IsAtOrUnderPath(string candidatePath, string rootPath)
    {
        return !String.IsNullOrEmpty(candidatePath) && !String.IsNullOrEmpty(rootPath) &&
            (String.Equals(candidatePath, rootPath, StringComparison.Ordinal) ||
             candidatePath.StartsWith(rootPath + "/", StringComparison.Ordinal));
    }

    private static NewTaskPageAncestor[] ReadComposerAncestorEvidence(Result snapshot, Node composerNode,
        string composerDocumentPath)
    {
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null ||
            composerNode == null || String.IsNullOrEmpty(composerNode.Path)) return new NewTaskPageAncestor[0];
        string[] parts = composerNode.Path.Split('/');
        int documentLength = String.IsNullOrEmpty(composerDocumentPath) ? 0 : composerDocumentPath.Split('/').Length;
        List<Node> nearestFirst = new List<Node>();
        for (int length = parts.Length; length > 0; length--)
        {
            string candidatePath = String.Join("/", parts, 0, length);
            Node candidate = snapshot.AllNodeReferences.FirstOrDefault(node => node != null &&
                String.Equals(node.Path, candidatePath, StringComparison.Ordinal));
            // InspectInternal releases the root RCW before returning. It is
            // not an ancestor evidence source; retained nodes must still be
            // alive and belong to this bounded composer-to-Document chain.
            if (candidate == null || candidate.Depth <= 0 || candidate.Element == null) continue;
            nearestFirst.Add(candidate);
            if (documentLength > 0 && length <= documentLength) break;
        }
        if (nearestFirst.Count == 0) return new NewTaskPageAncestor[0];
        if (nearestFirst.Count > 8)
        {
            Node documentNode = String.IsNullOrEmpty(composerDocumentPath) ? null : nearestFirst.FirstOrDefault(node =>
                String.Equals(node.Path, composerDocumentPath, StringComparison.Ordinal));
            nearestFirst = nearestFirst.Take(7).ToList();
            if (documentNode != null && !nearestFirst.Any(node => String.Equals(node.Path, documentNode.Path, StringComparison.Ordinal)))
                nearestFirst.Add(documentNode);
        }
        List<NewTaskPageAncestor> result = new List<NewTaskPageAncestor>();
        foreach (Node node in nearestFirst.AsEnumerable().Reverse())
        {
            if (!HelperBudgetReady()) return new NewTaskPageAncestor[0];
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId)) return new NewTaskPageAncestor[0];
            result.Add(new NewTaskPageAncestor {
                depth = node.Depth,
                controlTypeId = typeId,
                accessibleName = SafeName(Property(node.Element, NamePropertyId)),
                automationId = SafeName(Property(node.Element, AutomationIdPropertyId)),
                className = SafeName(Property(node.Element, ClassNamePropertyId)),
                ariaRole = SafeName(Property(node.Element, AriaRolePropertyId)),
                pathHash = Hash(node.Path),
                runtimeIdHash = RuntimeIdHash(node.Element),
                regionHash = String.IsNullOrEmpty(node.RegionPath) ? String.Empty : Hash(node.RegionPath)
            });
        }
        return result.ToArray();
    }

    private static bool HasClassToken(string className, string expected)
    {
        if (String.IsNullOrWhiteSpace(className) || String.IsNullOrWhiteSpace(expected)) return false;
        return className.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Any(token => String.Equals(token, expected, StringComparison.Ordinal));
    }

    private static bool IsSidebarConversationCard(Node node)
    {
        return node != null && node.Depth > 0 && node.Element != null &&
            HasClassToken(SafeName(Property(node.Element, ClassNamePropertyId)), "conversation-agent-card");
    }

    private static string ConversationSurfacePath(List<Node> nodes, Node header)
    {
        bool nativeTopbar = nodes.Any(n => n.Depth > 0 && header.Path.StartsWith(n.Path + "/", StringComparison.Ordinal) &&
            HasClassToken(SafeName(Property(n.Element, ClassNamePropertyId)), "workbuddy-topbar-title"));
        if (!nativeTopbar) return String.Empty;
        Node view = nodes.Where(n => n.Depth > 0 && header.Path.StartsWith(n.Path + "/", StringComparison.Ordinal) &&
            SafeName(Property(n.Element, ClassNamePropertyId)).Split(' ').Any(c => c.StartsWith("_gridViewItem_", StringComparison.Ordinal)))
            .OrderByDescending(n => n.Depth).FirstOrDefault();
        return view == null ? String.Empty : view.Path;
    }

    private static int CountComposerAncestorClass(NewTaskPageAncestor[] ancestors, string expected)
    {
        if (ancestors == null) return 0;
        return ancestors.Count(node => node != null && HasClassToken(node.className, expected));
    }

    private static bool HasCompleteSnapshotStatus(Status status)
    {
        return status != null && !status.traversalTruncated && status.errorType == null &&
            String.IsNullOrEmpty(status.errorStage);
    }

    private static bool HasCompleteSnapshotStatus(Result snapshot)
    {
        return snapshot != null && HasCompleteSnapshotStatus(snapshot.status);
    }

    private static string ClassifySupportedGlobalNonChatPage(string[] selectedSiblingNames)
    {
        if (selectedSiblingNames == null || selectedSiblingNames.Length < 1 || selectedSiblingNames.Length > 4 ||
            selectedSiblingNames.Any(String.IsNullOrWhiteSpace)) return String.Empty;
        HashSet<string> categories = new HashSet<string>(StringComparer.Ordinal);
        foreach (string selectedName in selectedSiblingNames)
        {
            string name = selectedName.Trim().ToLowerInvariant();
            if (new[] { "技能", "专家·技能·连接器", "skills", "experts · skills · connectors" }.Contains(name)) categories.Add("skills");
            else if (new[] { "项目", "projects", "project" }.Contains(name)) categories.Add("projects");
            else return String.Empty;
        }
        return categories.Count == 1 ? categories.First() : String.Empty;
    }

    // Keep this pure helper shared by the live UIA path and the PowerShell
    // fixture. Only a known selected sibling of the actual global New Task
    // tab can authorize the non-chat navigation branch.
    public static string ClassifyGlobalNonChatPageForFixture(string[] selectedSiblingNames)
    {
        return ClassifySupportedGlobalNonChatPage(selectedSiblingNames);
    }

    private static bool HasKnownConversationSurface(Result snapshot, string[] knownConversationTitles)
    {
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null ||
            knownConversationTitles == null || knownConversationTitles.Length > 200) return true;
        HashSet<string> titles = new HashSet<string>(knownConversationTitles, StringComparer.Ordinal);
        if (titles.Count != knownConversationTitles.Length || titles.Any(title => String.IsNullOrWhiteSpace(title) || title.Length > 180 ||
            System.Text.RegularExpressions.Regex.IsMatch(title, @"[\r\n\p{Cc}]"))) return true;

        List<string> conversationRows = new List<string>();
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null || node.Depth <= 0 || node.Element == null) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId)) return true;
            if (typeId == 50019 && BoolProperty(node.Element, SelectedPropertyId) && titles.Contains(SafeName(Property(node.Element, NamePropertyId))))
                return true;
            if (typeId == 50000 && BoolProperty(node.Element, EnabledPropertyId) && !BoolProperty(node.Element, OffscreenPropertyId))
            {
                string rowTitle = ConversationRowTitle(SafeName(Property(node.Element, NamePropertyId)));
                if (IsSidebarConversationCard(node) || titles.Contains(rowTitle)) conversationRows.Add(node.Path);
            }
        }
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null || node.Depth <= 0 || node.Element == null) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId)) return true;
            if (typeId == 50020 && !BoolProperty(node.Element, OffscreenPropertyId) &&
                titles.Contains(SafeName(Property(node.Element, NamePropertyId))) &&
                !conversationRows.Any(rowPath => node.Path.StartsWith(rowPath + "/", StringComparison.Ordinal))) return true;
        }
        return false;
    }

    private static bool TryClassifyNonChatNewTaskNavigation(Result snapshot, Node targetNode,
        string[] knownConversationTitles, out string pageKind)
    {
        pageKind = String.Empty;
        if (!HasCompleteSnapshotStatus(snapshot) || targetNode == null || targetNode.Element == null ||
            snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null || knownConversationTitles == null ||
            snapshot.status.composerBindingSucceeded || snapshot.status.composerModelCandidates != 0 ||
            snapshot.status.composerSendCandidates != 0 || HasKnownConversationSurface(snapshot, knownConversationTitles)) return false;

        List<ControlSummary> composers = snapshot.controls.Where(control => control != null && control.safeActionLabel == "composer").ToList();
        List<ControlSummary> selectors = snapshot.controls.Where(control => control != null && control.safeActionLabel == "model-selector").ToList();
        List<ControlSummary> sends = snapshot.controls.Where(control => control != null && control.safeActionLabel == "send-label").ToList();
        if (composers.Count != 0 || selectors.Count != 0 || sends.Count != 0) return false;

        string parentPath = targetNode.Path.Contains("/") ? targetNode.Path.Substring(0, targetNode.Path.LastIndexOf('/')) : String.Empty;
        int parentType;
        if (!snapshot.NodeTypeByPath.TryGetValue(parentPath, out parentType) || parentType != 50018) return false;
        List<string> selectedSiblingNames = new List<string>();
        foreach (Node candidate in snapshot.AllNodeReferences)
        {
            if (candidate == null || candidate.Depth <= 0 || candidate.Element == null) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50019) continue;
            string candidateParentPath = candidate.Path.Contains("/") ? candidate.Path.Substring(0, candidate.Path.LastIndexOf('/')) : String.Empty;
            if (!String.Equals(candidateParentPath, parentPath, StringComparison.Ordinal) ||
                !BoolProperty(candidate.Element, SelectedPropertyId)) continue;
            if (String.Equals(candidate.Path, targetNode.Path, StringComparison.Ordinal)) return false;
            selectedSiblingNames.Add(SafeName(Property(candidate.Element, NamePropertyId)));
        }
        if (selectedSiblingNames.Count != 1) return false;
        pageKind = ClassifySupportedGlobalNonChatPage(selectedSiblingNames.ToArray());
        return !String.IsNullOrEmpty(pageKind);
    }

    private static bool ValidComposerHomeAncestorChain(NewTaskPageAncestor[] ancestors, string documentRegionHash)
    {
        if (ancestors == null || ancestors.Length < 4 || ancestors.Length > 8 ||
            !System.Text.RegularExpressions.Regex.IsMatch(documentRegionHash ?? String.Empty, "^[a-f0-9]{16}$")) return false;
        HashSet<string> paths = new HashSet<string>(StringComparer.Ordinal);
        int previousDepth = 0;
        foreach (NewTaskPageAncestor node in ancestors)
        {
            if (node == null || node.depth <= previousDepth || node.depth > 256 ||
                node.pathHash == null || !System.Text.RegularExpressions.Regex.IsMatch(node.pathHash, "^[a-f0-9]{16}$") ||
                node.runtimeIdHash == null || !System.Text.RegularExpressions.Regex.IsMatch(node.runtimeIdHash, "^[a-f0-9]{16}$") ||
                node.controlTypeId < 0 || node.controlTypeId > 100000 || !paths.Add(node.pathHash)) return false;
            previousDepth = node.depth;
        }
        return ancestors[0].controlTypeId == 50030 &&
            ancestors[0].ariaRole == "document" &&
            ancestors[0].regionHash != null && System.Text.RegularExpressions.Regex.IsMatch(ancestors[0].regionHash, "^[a-f0-9]{16}$") &&
            ancestors[ancestors.Length - 1].controlTypeId == 50004 &&
            ancestors[ancestors.Length - 1].ariaRole == "textbox" &&
            CountComposerAncestorClass(ancestors, "wb-home-page") == 1 &&
            CountComposerAncestorClass(ancestors, "wb-home-composer") == 1 &&
            CountComposerAncestorClass(ancestors, "wb-home-route__input-wrap") == 1;
    }

    public static NewTaskPageProof BuildNewTaskPageProof(bool snapshotComplete, int selectedNewTaskTabCount,
        int selectedConversationTabMatches, int conversationHeaderMatches, int visibleWelcomeMarkerMatches,
        int composerDocumentWelcomeMarkerMatches, string composerDocumentRegionHash, NewTaskPageAncestor[] composerAncestors)
    {
        NewTaskPageAncestor[] safeAncestors = composerAncestors ?? new NewTaskPageAncestor[0];
        bool validAncestorChain = ValidComposerHomeAncestorChain(safeAncestors, composerDocumentRegionHash);
        NewTaskPageProof proof = new NewTaskPageProof {
            snapshotComplete = snapshotComplete,
            selectedNewTaskTabCount = selectedNewTaskTabCount,
            selectedConversationTabMatches = selectedConversationTabMatches,
            conversationHeaderMatches = conversationHeaderMatches,
            visibleWelcomeMarkerMatches = visibleWelcomeMarkerMatches,
            composerDocumentWelcomeMarkerMatches = composerDocumentWelcomeMarkerMatches,
            homePageAncestorMatches = CountComposerAncestorClass(safeAncestors, "wb-home-page"),
            homeComposerAncestorMatches = CountComposerAncestorClass(safeAncestors, "wb-home-composer"),
            homeRouteInputAncestorMatches = CountComposerAncestorClass(safeAncestors, "wb-home-route__input-wrap"),
            composerDocumentRegionHash = composerDocumentRegionHash ?? String.Empty,
            composerDocumentTextSampleCount = 0,
            composerDocumentTextSamples = new string[0],
            composerAncestorCount = safeAncestors.Length,
            composerAncestors = safeAncestors
        };
        bool validCounts = selectedNewTaskTabCount >= 0 && selectedNewTaskTabCount <= 5000 &&
            selectedConversationTabMatches >= 0 && selectedConversationTabMatches <= 5000 &&
            conversationHeaderMatches >= 0 && conversationHeaderMatches <= 5000 &&
            visibleWelcomeMarkerMatches >= 0 && visibleWelcomeMarkerMatches <= 5000 &&
            composerDocumentWelcomeMarkerMatches >= 0 && composerDocumentWelcomeMarkerMatches <= 5000 &&
            proof.homePageAncestorMatches >= 0 && proof.homePageAncestorMatches <= 8 &&
            proof.homeComposerAncestorMatches >= 0 && proof.homeComposerAncestorMatches <= 8 &&
            proof.homeRouteInputAncestorMatches >= 0 && proof.homeRouteInputAncestorMatches <= 8;
        proof.verified = snapshotComplete && validCounts && selectedNewTaskTabCount == 1 &&
            selectedConversationTabMatches == 0 && conversationHeaderMatches == 0 &&
            proof.homePageAncestorMatches == 1 && proof.homeComposerAncestorMatches == 1 &&
            proof.homeRouteInputAncestorMatches == 1 && validAncestorChain;
        if (!validCounts) proof.snapshotComplete = false;
        return proof;
    }

    public static NewTaskPageProof AnalyzeNewTaskPage(Result snapshot, string[] knownConversationTitles)
    {
        NewTaskPageProof proof = new NewTaskPageProof {
            snapshotComplete = snapshot != null && HasCompleteSnapshotStatus(snapshot) &&
                snapshot.controls != null && snapshot.NodeReferences != null && snapshot.AllNodeReferences != null &&
                snapshot.NodeTypeByPath != null && snapshot.controls.Length == snapshot.NodeReferences.Length,
            composerDocumentRegionHash = String.Empty,
            composerDocumentTextSampleCount = 0,
            composerDocumentTextSamples = new string[0],
            composerAncestorCount = 0,
            composerAncestors = new NewTaskPageAncestor[0]
        };
        if (!proof.snapshotComplete || knownConversationTitles == null || knownConversationTitles.Length > 200 ||
            knownConversationTitles.Any(title => String.IsNullOrWhiteSpace(title) || title.Length > 180 ||
                System.Text.RegularExpressions.Regex.IsMatch(title, @"[\r\n\p{Cc}]"))) return proof;

        HashSet<string> titleSet = new HashSet<string>(knownConversationTitles, StringComparer.Ordinal);
        if (titleSet.Count != knownConversationTitles.Length) return proof;
        List<ControlSummary> selectedNewTaskTabs = snapshot.controls.Where(control => control != null &&
            control.safeActionLabel == "new-task-tab" && control.identityRole == "new-task-navigation-tab" &&
            control.controlType == "ControlType.TabItem" && control.controlTypeId == 50019 && control.selected &&
            control.enabled && !control.offscreen && !control.passwordProtected &&
            control.runtimeIdHash != null && control.runtimeIdHash.Length == 16 &&
            control.regionHash != null && control.regionHash.Length == 16 && control.patterns != null &&
            control.patterns.Contains("selectionItem")).ToList();
        proof.selectedNewTaskTabCount = selectedNewTaskTabs.Count;

        List<int> composerIndexes = new List<int>();
        for (int i = 0; i < snapshot.controls.Length; i++)
            if (snapshot.controls[i] != null && snapshot.controls[i].safeActionLabel == "composer") composerIndexes.Add(i);
        string composerDocumentPath = String.Empty;
        string composerControlGroupPath = String.Empty;
        List<string> composerDocumentTextSamples = new List<string>();
        List<string> composerGroupTextSamples = new List<string>();
        List<string> otherDocumentTextSamples = new List<string>();
        if (snapshot.status.composerBindingSucceeded && composerIndexes.Count == 1)
        {
            Node composerNode = snapshot.NodeReferences[composerIndexes[0]];
            if (composerNode != null && composerNode.Element != null)
            {
                composerDocumentPath = NearestDocumentAncestorPath(snapshot, composerNode.Path);
                if (!String.IsNullOrEmpty(composerDocumentPath))
                    proof.composerDocumentRegionHash = Hash(composerDocumentPath);
                proof.composerAncestors = ReadComposerAncestorEvidence(snapshot, composerNode, composerDocumentPath);
                proof.composerAncestorCount = proof.composerAncestors.Length;

                int modelIndex = -1;
                int sendIndex = -1;
                for (int i = 0; i < snapshot.controls.Length; i++)
                {
                    if (snapshot.controls[i] == null) continue;
                    if (snapshot.controls[i].safeActionLabel == "model-selector") modelIndex = i;
                    else if (snapshot.controls[i].safeActionLabel == "send-label") sendIndex = i;
                }
                if (modelIndex >= 0 && sendIndex >= 0)
                {
                    Node modelNode = snapshot.NodeReferences[modelIndex];
                    Node sendNode = snapshot.NodeReferences[sendIndex];
                    int groupDepth;
                    int groupTypeId;
                    composerControlGroupPath = CommonAncestorPath(composerNode.Path, modelNode.Path, sendNode.Path, out groupDepth);
                    if (groupDepth < 3 || !snapshot.NodeTypeByPath.TryGetValue(composerControlGroupPath, out groupTypeId) ||
                        (groupTypeId != 50026 && groupTypeId != 50033)) composerControlGroupPath = String.Empty;
                    if (!String.IsNullOrEmpty(composerDocumentPath) && !String.IsNullOrEmpty(composerControlGroupPath) &&
                        !IsAtOrUnderPath(composerControlGroupPath, composerDocumentPath)) composerControlGroupPath = String.Empty;
                }
            }
        }

        foreach (Node candidate in snapshot.AllNodeReferences)
        {
            if (candidate == null) { proof.snapshotComplete = false; return proof; }
            if (candidate.Depth <= 0) continue;
            int typeId;
            if (candidate.Element == null || !snapshot.NodeTypeByPath.TryGetValue(candidate.Path, out typeId))
            { proof.snapshotComplete = false; return proof; }
            if (typeId == 50019 && BoolProperty(candidate.Element, SelectedPropertyId))
            {
                string tabName = SafeName(Property(candidate.Element, NamePropertyId));
                string rowTitle = ConversationRowTitle(tabName);
                if (titleSet.Contains(tabName) || titleSet.Contains(rowTitle)) proof.selectedConversationTabMatches++;
            }
            if (typeId != 50020 || BoolProperty(candidate.Element, OffscreenPropertyId)) continue;
            string visibleText = SafeName(Property(candidate.Element, NamePropertyId));
            if (IsNewTaskWelcomeMarker(visibleText))
            {
                proof.visibleWelcomeMarkerMatches++;
                if (IsAtOrUnderPath(candidate.Path, composerDocumentPath))
                {
                    proof.composerDocumentWelcomeMarkerMatches++;
                    if (!composerDocumentTextSamples.Contains(visibleText) && composerDocumentTextSamples.Count < 8)
                        composerDocumentTextSamples.Insert(0, visibleText);
                }
            }
            else if (IsAtOrUnderPath(candidate.Path, composerDocumentPath) && visibleText.Length > 0 && visibleText.Length <= 240)
            {
                List<string> destination = IsAtOrUnderPath(candidate.Path, composerControlGroupPath)
                    ? composerGroupTextSamples : otherDocumentTextSamples;
                if (!destination.Contains(visibleText)) destination.Add(visibleText);
            }
        }

        foreach (string value in composerGroupTextSamples.Concat(otherDocumentTextSamples))
        {
            if (composerDocumentTextSamples.Count >= 8) break;
            if (!composerDocumentTextSamples.Contains(value)) composerDocumentTextSamples.Add(value);
        }

        proof.composerDocumentTextSampleCount = composerDocumentTextSamples.Count;
        proof.composerDocumentTextSamples = composerDocumentTextSamples.ToArray();

        List<string> conversationRowPaths = new List<string>();
        foreach (Node candidate in snapshot.AllNodeReferences)
        {
            if (candidate.Depth <= 0) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50000 ||
                !BoolProperty(candidate.Element, EnabledPropertyId) || BoolProperty(candidate.Element, OffscreenPropertyId)) continue;
            string rowTitle = ConversationRowTitle(SafeName(Property(candidate.Element, NamePropertyId)));
            if (titleSet.Contains(rowTitle)) conversationRowPaths.Add(candidate.Path);
        }
        foreach (Node candidate in snapshot.AllNodeReferences)
        {
            if (candidate.Depth <= 0) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50020 ||
                BoolProperty(candidate.Element, OffscreenPropertyId)) continue;
            string visibleText = SafeName(Property(candidate.Element, NamePropertyId));
            if (titleSet.Contains(visibleText) && !conversationRowPaths.Any(rowPath =>
                candidate.Path.StartsWith(rowPath + "/", StringComparison.Ordinal))) proof.conversationHeaderMatches++;
        }

        NewTaskPageProof completed = BuildNewTaskPageProof(proof.snapshotComplete, proof.selectedNewTaskTabCount,
            proof.selectedConversationTabMatches, proof.conversationHeaderMatches, proof.visibleWelcomeMarkerMatches,
            proof.composerDocumentWelcomeMarkerMatches, proof.composerDocumentRegionHash, proof.composerAncestors);
        completed.composerDocumentTextSampleCount = composerDocumentTextSamples.Count;
        completed.composerDocumentTextSamples = composerDocumentTextSamples.ToArray();
        completed.composerAncestorCount = proof.composerAncestorCount;
        completed.composerAncestors = proof.composerAncestors ?? new NewTaskPageAncestor[0];
        return completed;
    }

    // Execute exactly one standard UI Automation pattern call against a fresh
    // Raw View tree. The caller must still verify the target conversation and
    // native postcondition around this primitive. A structural path hash is
    // deliberately never accepted as an action target.
    private static bool NewTaskIntentMatches(Result snapshot, string[] knownConversationTitles,
        string expectedDraftFingerprint, bool requireEmptyDraft)
    {
        if (!HasCompleteSnapshotStatus(snapshot) || snapshot.controls == null || snapshot.NodeReferences == null || snapshot.AllNodeReferences == null ||
            snapshot.controls.Length != snapshot.NodeReferences.Length || knownConversationTitles == null ||
            knownConversationTitles.Length > 200 || String.IsNullOrEmpty(expectedDraftFingerprint) ||
            !System.Text.RegularExpressions.Regex.IsMatch(expectedDraftFingerprint, "^[a-f0-9]{16}$")) return false;
        foreach (string title in knownConversationTitles)
        {
            if (String.IsNullOrWhiteSpace(title) || title.Length > 180 ||
                System.Text.RegularExpressions.Regex.IsMatch(title, @"[\r\n\p{Cc}]")) return false;
        }

        NewTaskPageProof pageProof = AnalyzeNewTaskPage(snapshot, knownConversationTitles);
        if (pageProof == null || !pageProof.verified || !snapshot.status.composerBindingSucceeded) return false;
        string composerRegion = null;
        List<ControlSummary> composers = snapshot.controls.Where(control => control != null &&
            control.safeActionLabel == "composer" && control.enabled && !control.offscreen && !control.passwordProtected &&
            control.draftFingerprint == expectedDraftFingerprint &&
            control.draftState == (requireEmptyDraft ? "empty" : "non-empty") &&
            control.regionHash.Length == 16 && control.runtimeIdHash.Length == 16 &&
            control.patterns.Contains("value")).ToList();
        List<ControlSummary> selectors = snapshot.controls.Where(control => control != null &&
            control.safeActionLabel == "model-selector" && control.controlType == "ControlType.ComboBox" &&
            control.enabled && !control.offscreen && !control.passwordProtected &&
            control.regionHash.Length == 16 && control.runtimeIdHash.Length == 16 &&
            !String.IsNullOrWhiteSpace(NormalizeModelName(control.accessibleName))).ToList();
        if (composers.Count != 1 || selectors.Count != 1 ||
            !String.Equals(composers[0].regionHash, selectors[0].regionHash, StringComparison.Ordinal)) return false;
        composerRegion = composers[0].regionHash;
        List<ControlSummary> sends = snapshot.controls.Where(control => control != null &&
            control.safeActionLabel == "send-label" && !control.offscreen && !control.passwordProtected &&
            control.regionHash == composerRegion && control.enabled == !requireEmptyDraft &&
            control.runtimeIdHash.Length == 16 && control.patterns.Contains("invoke")).ToList();
        if (sends.Count != 1) return false;

        return true;
    }

    public static ActionResult ExecuteSemanticAction(IntPtr hwnd, int expectedProcessId, string operation,
        string runtimeIdHash, string regionHash, string safeActionLabel,
        string expectedDraftFingerprint, string payload, string identityTitle, string[][] identityCandidates, int expectedCandidateIndex,
        string expectedControlName = null, bool requireNewTaskIntent = false, string[] knownConversationTitles = null)
    {
        ActionResult output = new ActionResult { operation = operation ?? String.Empty, attempted = false, submitted = false,
            newTaskNavigationSource = String.Empty, hresult = unchecked((int)0x80004005), stage = "validate" };
        if (String.IsNullOrEmpty(runtimeIdHash) || !System.Text.RegularExpressions.Regex.IsMatch(runtimeIdHash, "^[a-f0-9]{16}$") ||
            String.IsNullOrEmpty(regionHash) || !System.Text.RegularExpressions.Regex.IsMatch(regionHash, "^[a-f0-9]{16}$")) return output;

        bool setValue = operation == "set-value";
        bool invoke = operation == "invoke";
        bool expand = operation == "expand";
        bool collapse = operation == "collapse";
        bool select = operation == "select";
        if (!setValue && !invoke && !expand && !collapse && !select) return output;
        if (setValue && (safeActionLabel != "composer" || String.IsNullOrEmpty(expectedDraftFingerprint) ||
            payload == null || payload.Length > 65536)) return output;
        if (!setValue && !String.IsNullOrEmpty(payload)) return output;
        if (invoke && new[] { "send-label", "stop-label", "answer-label", "allow-once-label", "reject-label" }.Contains(safeActionLabel) == false) return output;
        if ((expand || collapse) && safeActionLabel != "model-selector" && safeActionLabel != "workspace-selector") return output;
        if (select && safeActionLabel != "model-option" && safeActionLabel != "workspace-option" && safeActionLabel != "new-task-tab") return output;
        if (requireNewTaskIntent && !((operation == "set-value" && safeActionLabel == "composer") ||
            (operation == "invoke" && safeActionLabel == "send-label"))) return output;
        if (expectedCandidateIndex < -1 || (identityTitle == null && identityCandidates != null && identityCandidates.Length > 0) ||
            (identityTitle != null && (identityCandidates == null || identityCandidates.Length < 1 || identityCandidates.Length > 64 ||
                expectedCandidateIndex < 0 || expectedCandidateIndex >= identityCandidates.Length))) return output;

        output.stage = "fresh-tree";
        bool requiresConversationIdentity = new[] { "composer", "send-label", "stop-label", "answer-label", "allow-once-label", "reject-label",
            "model-option", "workspace-option" }.Contains(safeActionLabel) && !requireNewTaskIntent;
        if (requiresConversationIdentity && (String.IsNullOrWhiteSpace(identityTitle) || identityCandidates == null || expectedCandidateIndex < 0))
        { output.stage = "conversation-identity"; return output; }
        if (requireNewTaskIntent && (identityTitle != null || (identityCandidates != null && identityCandidates.Length > 0)))
        { output.stage = "new-task-intent-precondition"; return output; }
        Result snapshot = requiresConversationIdentity
            ? InspectSemanticIdentity(hwnd, 5000, 3000, identityTitle, identityCandidates)
            : InspectSemantic(hwnd, 5000, 3000);
        if (!HasCompleteSnapshotStatus(snapshot) || snapshot.controls == null || snapshot.NodeReferences == null ||
            snapshot.controls.Length != snapshot.NodeReferences.Length) return output;
        if (requiresConversationIdentity)
        {
            ConversationIdentityProof proof = snapshot.identityProof;
            if (proof == null || proof.conversationRowMatches < 0 || proof.conversationHeaderMatches != 1 ||
                proof.candidateCount != identityCandidates.Length || proof.matchedCandidateIndex != expectedCandidateIndex)
            { output.stage = "conversation-identity"; return output; }
            output.conversationIdentityVerified = true;
        }
        if (requireNewTaskIntent)
        {
            bool requireEmptyDraft = operation == "set-value";
            if (!NewTaskIntentMatches(snapshot, knownConversationTitles, expectedDraftFingerprint, requireEmptyDraft))
            { output.stage = "new-task-intent-precondition"; return output; }
            output.newTaskIntentVerified = true;
        }

        List<int> matches = new List<int>();
        for (int i = 0; i < snapshot.controls.Length; i++)
        {
            ControlSummary control = snapshot.controls[i];
            if (control != null && control.runtimeIdHash == runtimeIdHash && control.regionHash == regionHash &&
                control.safeActionLabel == safeActionLabel) matches.Add(i);
        }
        output.matchingControls = matches.Count;
        if (matches.Count != 1) { output.stage = "unique-runtime-target"; return output; }

        int matchIndex = matches[0];
        ControlSummary target = snapshot.controls[matchIndex];
        Node node = snapshot.NodeReferences[matchIndex];
        if (node == null || node.Element == null || target.passwordProtected || target.offscreen || !target.enabled ||
            String.IsNullOrEmpty(target.runtimeIdHash)) { output.stage = "target-state"; return output; }
        if (!String.IsNullOrEmpty(expectedControlName) &&
            (!String.Equals(target.accessibleName, expectedControlName, StringComparison.Ordinal) ||
             !String.Equals(SafeName(Property(node.Element, NamePropertyId)), expectedControlName, StringComparison.Ordinal)))
        { output.stage = "target-state"; return output; }
        if (select && safeActionLabel == "new-task-tab")
        {
            string parentPath = node.Path.Contains("/") ? node.Path.Substring(0, node.Path.LastIndexOf('/')) : String.Empty;
            int parentType;
            if (target.controlType != "ControlType.TabItem" || target.controlTypeId != 50019 ||
                !snapshot.NodeTypeByPath.TryGetValue(parentPath, out parentType) || parentType != 50018 ||
                target.identityRole != "new-task-navigation-tab" || !target.patterns.Contains("selectionItem"))
            { output.stage = "selection-pattern"; return output; }
            List<ControlSummary> boundComposers = snapshot.controls.Where(control => control != null && control.safeActionLabel == "composer" &&
                !control.passwordProtected && !control.offscreen).ToList();
            if (snapshot.status.composerBindingSucceeded)
            {
                List<ControlSummary> selectors = snapshot.controls.Where(control => control != null && control.safeActionLabel == "model-selector" &&
                    !control.passwordProtected && !control.offscreen && control.enabled).ToList();
                List<ControlSummary> sends = snapshot.controls.Where(control => control != null && control.safeActionLabel == "send-label" &&
                    !control.passwordProtected && !control.offscreen).ToList();
                List<int> exactComposers = Enumerable.Range(0, snapshot.controls.Length).Where(index => {
                    ControlSummary control = snapshot.controls[index];
                    return control != null && control.safeActionLabel == "composer" && control.enabled && !control.offscreen &&
                        !control.passwordProtected && control.draftState == "empty" && control.patterns.Contains("value") &&
                        control.regionHash == boundComposers[0].regionHash;
                }).ToList();
                if (boundComposers.Count != 1 || selectors.Count != 1 || sends.Count != 1 || exactComposers.Count != 1 ||
                    selectors[0].controlType != "ControlType.ComboBox" || !selectors[0].enabled ||
                    selectors[0].regionHash != boundComposers[0].regionHash || sends[0].regionHash != boundComposers[0].regionHash || sends[0].enabled ||
                    snapshot.NodeReferences[exactComposers[0]] == null || snapshot.NodeReferences[exactComposers[0]].Element == null)
                { output.stage = "draft-precondition"; return output; }
                string currentDraft = Property(snapshot.NodeReferences[exactComposers[0]].Element, ValuePropertyId) as string;
                ControlSummary emptyComposer = snapshot.controls[exactComposers[0]];
                if (currentDraft == null || NormalizeComposerDraft(currentDraft, true).Length != 0 ||
                    ComposerDraftFingerprint(currentDraft, true) != emptyComposer.draftFingerprint)
                { output.stage = "draft-precondition"; return output; }
                output.newTaskNavigationSource = "empty-composer";
            }
            else
            {
                string pageKind;
                if (boundComposers.Count != 0 || !TryClassifyNonChatNewTaskNavigation(snapshot, node,
                    knownConversationTitles, out pageKind))
                { output.stage = "draft-precondition"; return output; }
                output.newTaskNavigationSource = pageKind;
            }
        }
        if ((expand || collapse) && safeActionLabel == "model-selector" && !String.IsNullOrEmpty(expectedDraftFingerprint))
        {
            List<ControlSummary> composers = snapshot.controls.Where(control => control != null && control.safeActionLabel == "composer" &&
                control.regionHash == target.regionHash && control.draftState != "unavailable" &&
                control.draftFingerprint == expectedDraftFingerprint && !control.passwordProtected && !control.offscreen && control.enabled).ToList();
            List<ControlSummary> sendControls = snapshot.controls.Where(control => control != null && control.safeActionLabel == "send-label" &&
                control.regionHash == target.regionHash && !control.passwordProtected && !control.offscreen).ToList();
            if (!snapshot.status.composerBindingSucceeded || composers.Count != 1 || sendControls.Count != 1)
            { output.stage = "draft-precondition"; return output; }
            List<Node> composerNodes = snapshot.NodeReferences.Where((candidate, index) => index < snapshot.controls.Length &&
                snapshot.controls[index] != null && snapshot.controls[index].safeActionLabel == "composer" &&
                snapshot.controls[index].regionHash == target.regionHash && snapshot.controls[index].draftFingerprint == expectedDraftFingerprint).ToList();
            if (composerNodes.Count != 1 || composerNodes[0] == null || composerNodes[0].Element == null)
            { output.stage = "draft-precondition"; return output; }
            string currentDraft = Property(composerNodes[0].Element, ValuePropertyId) as string;
            if (currentDraft == null || ComposerDraftFingerprint(currentDraft, !sendControls[0].enabled) != expectedDraftFingerprint)
            { output.stage = "draft-precondition"; return output; }
        }
        if (setValue && (target.draftState != "empty" || target.draftFingerprint != expectedDraftFingerprint ||
            !snapshot.status.composerBindingSucceeded || !target.patterns.Contains("value"))) { output.stage = "draft-precondition"; return output; }
        if (invoke && (!target.patterns.Contains("invoke") || (safeActionLabel == "send-label" && !snapshot.status.composerBindingSucceeded)))
        { output.stage = "invoke-pattern"; return output; }
        if ((expand || collapse) && !target.patterns.Contains("expandCollapse")) { output.stage = "expand-collapse-pattern"; return output; }
        if (select && !target.patterns.Contains("selectionItem")) { output.stage = "selection-pattern"; return output; }
        if (!HelperBudgetReady()) { output.stage = "helper-budget-expired"; return output; }
        output.stage = "pattern-call";
        object pattern = null;
        try
        {
            int patternId = setValue ? ValuePatternId : invoke ? InvokePatternId :
                (expand || collapse) ? ExpandCollapsePatternId : SelectionItemPatternId;
            int patternHr = node.Element.GetCurrentPattern(patternId, out pattern);
            if (patternHr < 0 || pattern == null) { output.hresult = patternHr; return output; }

            if (setValue)
            {
                WorkBuddyIUIAutomationValuePattern valuePattern = pattern as WorkBuddyIUIAutomationValuePattern;
                if (valuePattern == null) { output.hresult = unchecked((int)0x80004002); return output; }
                bool readOnly;
                int readOnlyHr = valuePattern.get_CurrentIsReadOnly(out readOnly);
                if (readOnlyHr < 0 || readOnly) { output.hresult = readOnlyHr < 0 ? readOnlyHr : unchecked((int)0x80070005); return output; }
                string currentDraft = Property(node.Element, ValuePropertyId) as string;
                List<ControlSummary> boundSendControls = snapshot.controls.Where(control => control != null && control.safeActionLabel == "send-label" &&
                    control.regionHash == target.regionHash && !control.passwordProtected && !control.offscreen).ToList();
                if (currentDraft == null || boundSendControls.Count != 1 || boundSendControls[0].enabled ||
                    NormalizeComposerDraft(currentDraft, true).Length != 0 || ComposerDraftFingerprint(currentDraft, true) != expectedDraftFingerprint)
                { output.hresult = unchecked((int)0x80070490); output.stage = "draft-precondition"; return output; }
                if (!NativeActionTargetReady(hwnd, expectedProcessId)) { output.stage = "target-context-precondition"; return output; }
                if (!HelperBudgetReady()) { output.stage = "helper-budget-expired"; return output; }
                output.attempted = true;
                output.targetContextVerified = true;
                output.foregroundVerified = IsTargetForeground(hwnd);
                output.hresult = valuePattern.SetValue(payload);
            }
            else if (invoke)
            {
                WorkBuddyIUIAutomationInvokePattern invokePattern = pattern as WorkBuddyIUIAutomationInvokePattern;
                if (invokePattern == null) { output.hresult = unchecked((int)0x80004002); return output; }
                if (safeActionLabel == "send-label")
                {
                    List<int> composers = Enumerable.Range(0, snapshot.controls.Length).Where(index => {
                        ControlSummary control = snapshot.controls[index];
                        return control != null && control.safeActionLabel == "composer" && control.regionHash == regionHash &&
                            control.draftState == "non-empty" && control.draftFingerprint == expectedDraftFingerprint &&
                            !control.passwordProtected && !control.offscreen && control.enabled;
                    }).ToList();
                    if (String.IsNullOrEmpty(expectedDraftFingerprint) || composers.Count != 1 ||
                        snapshot.NodeReferences[composers[0]] == null || snapshot.NodeReferences[composers[0]].Element == null)
                    { output.hresult = unchecked((int)0x80070490); output.stage = "draft-precondition"; return output; }
                    string currentDraft = Property(snapshot.NodeReferences[composers[0]].Element, ValuePropertyId) as string;
                    if (currentDraft == null || ComposerDraftFingerprint(currentDraft, !target.enabled) != expectedDraftFingerprint)
                    { output.hresult = unchecked((int)0x80070490); output.stage = "draft-precondition"; return output; }
                }
                if (!NativeActionTargetReady(hwnd, expectedProcessId)) { output.stage = "target-context-precondition"; return output; }
                if (!HelperBudgetReady()) { output.stage = "helper-budget-expired"; return output; }
                output.attempted = true;
                output.targetContextVerified = true;
                output.foregroundVerified = IsTargetForeground(hwnd);
                output.hresult = invokePattern.Invoke();
            }
            else if (expand || collapse)
            {
                WorkBuddyIUIAutomationExpandCollapsePattern expandPattern = pattern as WorkBuddyIUIAutomationExpandCollapsePattern;
                if (expandPattern == null) { output.hresult = unchecked((int)0x80004002); return output; }
                int state;
                int stateHr = expandPattern.get_CurrentExpandCollapseState(out state);
                if (stateHr < 0) { output.hresult = stateHr; return output; }
                // UIA ExpandCollapseState: 0 collapsed, 1 expanded. Never
                // repeat an already-satisfied transition.
                if ((expand && state != 0) || (collapse && state != 1))
                { output.hresult = unchecked((int)0x80070490); output.stage = "state-precondition"; return output; }
                if (!NativeActionTargetReady(hwnd, expectedProcessId)) { output.stage = "target-context-precondition"; return output; }
                if (!HelperBudgetReady()) { output.stage = "helper-budget-expired"; return output; }
                output.attempted = true;
                output.targetContextVerified = true;
                output.foregroundVerified = IsTargetForeground(hwnd);
                output.hresult = expand ? expandPattern.Expand() : expandPattern.Collapse();
            }
            else
            {
                WorkBuddyIUIAutomationSelectionItemPattern selectionPattern = pattern as WorkBuddyIUIAutomationSelectionItemPattern;
                if (selectionPattern == null) { output.hresult = unchecked((int)0x80004002); return output; }
                bool selected;
                int selectedHr = selectionPattern.get_CurrentIsSelected(out selected);
                if (selectedHr < 0) { output.hresult = selectedHr; return output; }
                // The global New Task tab also remains selected while an
                // existing chat is open. Selecting it is an explicit page
                // action; the fresh empty-draft/global-tab checks above bind
                // that action. Other selected options need no repeated input.
                if (selected && safeActionLabel != "new-task-tab") { output.hresult = unchecked((int)0x80070490); output.stage = "state-precondition"; return output; }
                if (!NativeActionTargetReady(hwnd, expectedProcessId)) { output.stage = "target-context-precondition"; return output; }
                if (!HelperBudgetReady()) { output.stage = "helper-budget-expired"; return output; }
                output.attempted = true;
                output.targetContextVerified = true;
                output.foregroundVerified = IsTargetForeground(hwnd);
                output.hresult = selectionPattern.Select();
            }
            output.submitted = output.hresult >= 0;
            output.stage = output.submitted ? "submitted" : "pattern-call";
            return output;
        }
        catch
        {
            output.hresult = unchecked((int)0x80004005);
            output.stage = "pattern-call";
            return output;
        }
        finally
        {
            if (pattern != null && Marshal.IsComObject(pattern)) { try { Marshal.ReleaseComObject(pattern); } catch { } }
        }
    }

    private static string NormalizeModelName(string value)
    {
        string text = (value ?? String.Empty).Trim();
        if (text.StartsWith("Select model:", StringComparison.OrdinalIgnoreCase)) return text.Substring("Select model:".Length).Trim();
        if (text.StartsWith("选择模型：", StringComparison.Ordinal)) return text.Substring("选择模型：".Length).Trim();
        if (text.StartsWith("选择模型:", StringComparison.Ordinal)) return text.Substring("选择模型:".Length).Trim();
        return text;
    }

    private static bool TryGetModelFrame(Result snapshot, out ControlSummary selector, out Node selectorNode,
        out ControlSummary composer, out Node composerNode, out int expansionState)
    {
        selector = null; selectorNode = null; composer = null; composerNode = null; expansionState = -1;
        if (!HasCompleteSnapshotStatus(snapshot) || !snapshot.status.composerBindingSucceeded || snapshot.controls == null || snapshot.NodeReferences == null ||
            snapshot.controls.Length != snapshot.NodeReferences.Length) return false;
        List<int> selectors = Enumerable.Range(0, snapshot.controls.Length).Where(index =>
            snapshot.controls[index] != null && snapshot.controls[index].safeActionLabel == "model-selector" &&
            !snapshot.controls[index].offscreen && !snapshot.controls[index].passwordProtected && snapshot.controls[index].enabled &&
            snapshot.controls[index].runtimeIdHash.Length == 16 && snapshot.controls[index].regionHash.Length == 16 &&
            snapshot.controls[index].patterns.Contains("expandCollapse")).ToList();
        List<int> composers = Enumerable.Range(0, snapshot.controls.Length).Where(index =>
            snapshot.controls[index] != null && snapshot.controls[index].safeActionLabel == "composer" &&
            !snapshot.controls[index].offscreen && !snapshot.controls[index].passwordProtected && snapshot.controls[index].enabled &&
            snapshot.controls[index].draftState != "unavailable" && snapshot.controls[index].runtimeIdHash.Length == 16).ToList();
        if (selectors.Count != 1 || composers.Count != 1) return false;
        selector = snapshot.controls[selectors[0]];
        selectorNode = snapshot.NodeReferences[selectors[0]];
        composer = snapshot.controls[composers[0]];
        composerNode = snapshot.NodeReferences[composers[0]];
        if (selectorNode == null || selectorNode.Element == null || composerNode == null || composerNode.Element == null ||
            selector.regionHash != composer.regionHash || NormalizeModelName(selector.accessibleName).Length == 0) return false;
        object rawPattern = null;
        try
        {
            int hr = selectorNode.Element.GetCurrentPattern(ExpandCollapsePatternId, out rawPattern);
            WorkBuddyIUIAutomationExpandCollapsePattern pattern = rawPattern as WorkBuddyIUIAutomationExpandCollapsePattern;
            if (hr < 0 || pattern == null || pattern.get_CurrentExpandCollapseState(out expansionState) < 0) return false;
            return expansionState == 0 || expansionState == 1;
        }
        catch { return false; }
        finally { if (rawPattern != null && Marshal.IsComObject(rawPattern)) { try { Marshal.ReleaseComObject(rawPattern); } catch { } } }
    }

    private static string[] ModelOptions(Result snapshot, ControlSummary selector)
    {
        if (snapshot == null || snapshot.controls == null || selector == null) return new string[0];
        List<string> labels = new List<string>();
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (ControlSummary control in snapshot.controls)
        {
            if (control == null || control.safeActionLabel != "model-option" || control.regionHash != selector.regionHash ||
                !control.enabled || control.offscreen || control.passwordProtected || !IsSafeCatalogLabel(control.accessibleName)) continue;
            if (!seen.Add(control.accessibleName)) return new string[0];
            labels.Add(control.accessibleName);
        }
        return labels.Count <= 100 ? labels.ToArray() : new string[0];
    }

    private static List<string> DiagnosticPatterns(WorkBuddyIUIAutomationElement element)
    {
        List<string> patterns = new List<string>();
        AddPattern(patterns, element, InvokePatternId, "invoke");
        AddPattern(patterns, element, ValuePatternId, "value");
        AddPattern(patterns, element, ExpandCollapsePatternId, "expandCollapse");
        AddPattern(patterns, element, SelectionItemPatternId, "selectionItem");
        AddPattern(patterns, element, TogglePatternId, "toggle");
        return patterns;
    }

    private static bool IsUnderPath(Node candidate, Node root)
    {
        return candidate != null && root != null && candidate.Path != null && root.Path != null &&
            (String.Equals(candidate.Path, root.Path, StringComparison.Ordinal) ||
             candidate.Path.StartsWith(root.Path + "/", StringComparison.Ordinal));
    }

    private static int SelectedCurrentModelDescendants(Result snapshot, Node popupRoot, string currentModel)
    {
        int count = 0;
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null) return count;
        int visited = 0;
        foreach (Node candidate in snapshot.AllNodeReferences)
        {
            if (candidate == null || candidate.Element == null || !IsUnderPath(candidate, popupRoot) ||
                String.Equals(candidate.Path, popupRoot.Path, StringComparison.Ordinal) ||
                !snapshot.NodeTypeByPath.ContainsKey(candidate.Path)) continue;
            if (++visited > 256) return -1;
            if (BoolProperty(candidate.Element, OffscreenPropertyId) || !BoolProperty(candidate.Element, EnabledPropertyId) ||
                !BoolProperty(candidate.Element, SelectedPropertyId)) continue;
            if (!HasPattern(candidate.Element, SelectionItemPatternId)) continue;
            string name = SafeName(Property(candidate.Element, NamePropertyId));
            if (IsSafeCatalogLabel(name) && String.Equals(name, currentModel, StringComparison.Ordinal)) count++;
        }
        return count;
    }

    private static ModelMenuControl SummarizeModelMenuControl(Node node, Node root)
    {
        if (node == null || root == null || node.Element == null) return null;
        int typeId = 0;
        try { typeId = Convert.ToInt32(Property(node.Element, ControlTypePropertyId), CultureInfo.InvariantCulture); } catch { }
        string typeName = DiagnosticTypeName(typeId);
        bool password = BoolProperty(node.Element, IsPasswordPropertyId);
        string name = password ? String.Empty : SafeName(Property(node.Element, NamePropertyId));
        if (!IsSafeCatalogLabel(name)) name = String.Empty;
        List<string> patterns = password ? new List<string>() : DiagnosticPatterns(node.Element);
        int depth = Math.Max(0, node.Depth - root.Depth);
        return new ModelMenuControl {
            depthWithinPopup = depth,
            controlType = typeName,
            controlTypeId = typeId,
            accessibleName = name,
            enabled = BoolProperty(node.Element, EnabledPropertyId),
            offscreen = BoolProperty(node.Element, OffscreenPropertyId),
            selected = BoolProperty(node.Element, SelectedPropertyId),
            passwordProtected = password,
            patterns = patterns.ToArray(),
            pathHash = Hash(node.Path),
            runtimeIdHash = RuntimeIdHash(node.Element),
            regionHash = Hash(String.IsNullOrEmpty(node.RegionPath) ? "root" : node.RegionPath)
        };
    }

    // UI frameworks can render a model picker as a portal sibling instead of
    // a selector descendant. Accept only a newly visible native List or Menu
    // in the expanded snapshot, and capture no more than that popup subtree.
    // The current-model SelectedItem observation is returned as evidence; it
    // is not inferred from a renderer role or from a control's label alone.
    private static ModelMenuDiagnostic CaptureModelMenuDiagnostic(Result before, Result expanded, string currentModel)
    {
        ModelMenuDiagnostic diagnostic = new ModelMenuDiagnostic {
            association = "unavailable", newVisiblePopupRootCount = 0,
            selectedCurrentModelCount = 0, controls = new ModelMenuControl[0]
        };
        if (!HasCompleteSnapshotStatus(before) || !HasCompleteSnapshotStatus(expanded) ||
            before.AllNodeReferences == null || expanded.AllNodeReferences == null ||
            before.NodeTypeByPath == null || expanded.NodeTypeByPath == null ||
            currentModel == null || currentModel.Length == 0) return diagnostic;

        HashSet<string> beforeVisiblePopupIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (Node previous in before.AllNodeReferences)
        {
            if (previous == null || previous.Element == null) continue;
            int typeId;
            if (!before.NodeTypeByPath.TryGetValue(previous.Path, out typeId) || typeId != 50008 && typeId != 50009) continue;
            if (BoolProperty(previous.Element, OffscreenPropertyId) || !BoolProperty(previous.Element, EnabledPropertyId)) continue;
            string runtimeIdHash = RuntimeIdHash(previous.Element);
            if (runtimeIdHash.Length == 16) beforeVisiblePopupIds.Add(runtimeIdHash);
        }

        List<Node> roots = new List<Node>();
        foreach (Node candidate in expanded.AllNodeReferences)
        {
            if (candidate == null || candidate.Element == null || BoolProperty(candidate.Element, OffscreenPropertyId) ||
                !BoolProperty(candidate.Element, EnabledPropertyId)) continue;
            int typeId;
            if (!expanded.NodeTypeByPath.TryGetValue(candidate.Path, out typeId) || (typeId != 50008 && typeId != 50009)) continue;
            string runtimeIdHash = RuntimeIdHash(candidate.Element);
            if (runtimeIdHash.Length != 16) continue;
            bool wasVisible = beforeVisiblePopupIds.Contains(runtimeIdHash);
            if (!wasVisible) roots.Add(candidate);
            if (roots.Count > 32) return diagnostic;
        }

        // Some providers expose the popup as a Pane rather than a List/Menu.
        // A Pane is accepted only when it is the unique new visible container
        // holding the exact current model as a live selected UIA item.
        if (roots.Count == 0)
        {
            foreach (Node candidate in expanded.AllNodeReferences)
            {
                if (candidate == null || candidate.Element == null || BoolProperty(candidate.Element, OffscreenPropertyId) ||
                    !BoolProperty(candidate.Element, EnabledPropertyId)) continue;
                int typeId;
                if (!expanded.NodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50033) continue;
                string runtimeIdHash = RuntimeIdHash(candidate.Element);
                if (runtimeIdHash.Length != 16) continue;
                bool wasVisible = beforeVisiblePopupIds.Contains(runtimeIdHash);
                if (wasVisible || SelectedCurrentModelDescendants(expanded, candidate, currentModel) == 0) continue;
                roots.Add(candidate);
                if (roots.Count > 32) return diagnostic;
            }
        }

        // A popup may expose nested List/Menu controls. Keep only top-level
        // newly visible roots so a nested submenu does not manufacture an
        // ambiguity with its owning list.
        roots = roots.Where(candidate => !roots.Any(other => !Object.ReferenceEquals(candidate, other) &&
            other.Depth < candidate.Depth && IsUnderPath(candidate, other))).ToList();
        diagnostic.newVisiblePopupRootCount = roots.Count;
        if (roots.Count != 1) {
            diagnostic.association = roots.Count == 0 ? "no-new-visible-native-list" : "ambiguous-new-visible-native-lists";
            return diagnostic;
        }
        Node root = roots[0];
        int selectedModelCount = SelectedCurrentModelDescendants(expanded, root, currentModel);
        diagnostic.selectedCurrentModelCount = selectedModelCount;
        diagnostic.association = selectedModelCount == 1 ? "unique-new-popup-selected-current-model" :
            "unique-new-popup-without-selected-current-model-proof";

        List<ModelMenuControl> controls = new List<ModelMenuControl>();
        int subtreeNodes = 0;
        foreach (Node candidate in expanded.AllNodeReferences)
        {
            if (candidate == null || candidate.Element == null || !IsUnderPath(candidate, root) ||
                candidate.Depth > root.Depth + 8) continue;
            if (++subtreeNodes > 128) {
                diagnostic.association = "popup-subtree-exceeds-diagnostic-bound";
                diagnostic.controls = new ModelMenuControl[0];
                return diagnostic;
            }
            ModelMenuControl control = SummarizeModelMenuControl(candidate, root);
            if (control != null) controls.Add(control);
        }
        diagnostic.controls = controls.ToArray();
        return diagnostic;
    }

    private static void ApplyModelPopupInspection(ModelCatalogResult result, ModelPopupInspection popup,
        bool appearedDuringRead)
    {
        bool valid = popup != null && popup.complete && popup.selectedCurrentModelCount == 1 &&
            popup.options != null && popup.options.Length > 0 && popup.options.Length <= 100 &&
            popup.options.All(option => option != null && IsSafeCatalogLabel(option.modelName) &&
                !String.IsNullOrEmpty(option.runtimeIdHash) && option.runtimeIdHash.Length == 16 &&
                !String.IsNullOrEmpty(option.pathHash) && option.pathHash.Length == 16 &&
                !String.IsNullOrEmpty(option.regionHash) && option.regionHash.Length == 16) &&
            popup.options.Select(option => option.modelName).Distinct(StringComparer.Ordinal).Count() == popup.options.Length &&
            popup.options.Any(option => option.selected && option.enabled && String.Equals(option.modelName, result.currentModel, StringComparison.Ordinal));
        if (!valid)
        {
            result.reason = popup == null || String.IsNullOrEmpty(popup.reason) ? "native-model-options-unavailable" : popup.reason;
            result.models = new string[0];
            result.modelMenu = new ModelMenuDiagnostic {
                association = "unavailable", newVisiblePopupRootCount = 0,
                selectedCurrentModelCount = popup == null ? 0 : Math.Max(0, Math.Min(128, popup.selectedCurrentModelCount)),
                controls = new ModelMenuControl[0]
            };
            return;
        }

        result.models = popup.options.Where(option => option.enabled).Select(option => option.modelName).ToArray();
        result.modelMenu = new ModelMenuDiagnostic {
            association = "unique-associated-visible-popup-selected-current-model",
            newVisiblePopupRootCount = appearedDuringRead ? 1 : 0,
            selectedCurrentModelCount = popup.selectedCurrentModelCount,
            controls = new ModelMenuControl[0]
        };
    }

    private static bool FreshModelFrameMatches(IntPtr hwnd, string expectedModel, string expectedDraftFingerprint,
        out Result snapshot, out ControlSummary selector, out ControlSummary composer, out int expansionState)
    {
        snapshot = InspectSemantic(hwnd, 5000, 2500);
        Node selectorNode, composerNode;
        if (!TryGetModelFrame(snapshot, out selector, out selectorNode, out composer, out composerNode, out expansionState)) return false;
        return String.Equals(NormalizeModelName(selector.accessibleName), expectedModel, StringComparison.Ordinal) &&
            String.Equals(composer.draftFingerprint, expectedDraftFingerprint, StringComparison.Ordinal);
    }

    // Reads the real native model options without selecting one. Expansion and
    // collapse are separate UIA pattern calls, each preceded by a fresh Raw
    // View observation and each followed by a fresh observation. A non-empty
    // composer draft is preserved and fingerprint-checked across the sequence.
    public static ModelCatalogResult ReadNativeModelCatalog(IntPtr hwnd, int expectedProcessId)
    {
        ModelCatalogResult result = new ModelCatalogResult {
            outcome = "blocked", reason = "native-model-catalog-unavailable", currentModel = String.Empty,
            models = new string[0], initialDraftFingerprint = String.Empty, finalDraftFingerprint = String.Empty,
            composerVerified = false, initiallyExpanded = false, finallyExpanded = false,
            modelMenu = new ModelMenuDiagnostic { association = "unavailable", newVisiblePopupRootCount = 0,
                selectedCurrentModelCount = 0, controls = new ModelMenuControl[0] }, patternReceipts = new ActionResult[0]
        };
        if (!NativeActionTargetReady(hwnd, expectedProcessId)) { result.reason = "target-context-not-confirmed"; return result; }
        result.targetContextVerified = true;
        Result initial;
        ControlSummary selector, composer;
        Node selectorNode, composerNode;
        int state;
        initial = InspectSemantic(hwnd, 5000, 2500);
        if (!TryGetModelFrame(initial, out selector, out selectorNode, out composer, out composerNode, out state))
        { result.reason = "composer-or-model-selector-not-unique"; return result; }
        string currentModel = NormalizeModelName(selector.accessibleName);
        string initialDraft = composer.draftFingerprint;
        if (currentModel.Length == 0 || initialDraft.Length != 16)
        { result.reason = "native-model-frame-invalid"; return result; }
        result.currentModel = currentModel;
        result.initialDraftFingerprint = initialDraft;
        result.composerVerified = true;
        result.initiallyExpanded = state == 1;

        List<ActionResult> receipts = new List<ActionResult>();
        Result observed = initial;
        ControlSummary observedSelector = selector;
        int observedState = state;
        if (state == 0)
        {
            if (!NativeActionTargetReady(hwnd, expectedProcessId)) { result.reason = "target-context-not-confirmed"; return result; }
            if (!HelperBudgetReady()) { result.reason = "helper-budget-expired"; result.patternReceipts = receipts.ToArray(); return result; }
            ActionResult expanded = ExecuteSemanticAction(hwnd, expectedProcessId, "expand", selector.runtimeIdHash, selector.regionHash,
                "model-selector", initialDraft, null, null, null, -1, selector.accessibleName);
            receipts.Add(expanded);
            if (!expanded.submitted)
            {
                result.outcome = expanded.attempted || expanded.submitted ? "submitted" : "blocked";
                result.reason = "native-expand-not-submitted";
                result.patternReceipts = receipts.ToArray();
                return result;
            }
            // Chromium reports the expanded flag before React mounts the
            // controlled portal into the accessibility tree. This is a wait
            // for that single transition, never another Expand attempt.
            if (HelperBudgetReady()) System.Threading.Thread.Sleep(200);
            if (!FreshModelFrameMatches(hwnd, currentModel, initialDraft, out observed, out observedSelector, out composer, out observedState))
                result.reason = "native-model-frame-changed";
            else if (observedState == 1)
            {

                ApplyModelPopupInspection(result, InspectModelPopup(initial, observed, currentModel), true);
            }
            // Even an unsuccessful list read must close the dropdown that this
            // operation opened. Collapse is attempted once and never retried.
            if (!FreshModelFrameMatches(hwnd, currentModel, initialDraft, out observed, out observedSelector, out composer, out observedState) || observedState != 1)
            {
                result.outcome = receipts.Any(receipt => receipt.attempted || receipt.submitted) ? "submitted" : "blocked";
                result.reason = result.reason == "native-model-frame-changed" ? result.reason : "native-expand-state-unverified";
                result.patternReceipts = receipts.ToArray();
                return result;
            }
            if (!NativeActionTargetReady(hwnd, expectedProcessId)) {
                result.outcome = receipts.Any(receipt => receipt.attempted || receipt.submitted) ? "submitted" : "blocked";
                result.reason = "target-context-not-confirmed"; result.patternReceipts = receipts.ToArray(); return result;
            }
            if (!HelperBudgetReady()) { result.outcome = receipts.Any(receipt => receipt.attempted) ? "submitted" : "blocked"; result.reason = "helper-budget-expired"; result.patternReceipts = receipts.ToArray(); return result; }
            ActionResult collapsed = ExecuteSemanticAction(hwnd, expectedProcessId, "collapse", observedSelector.runtimeIdHash, observedSelector.regionHash,
                "model-selector", initialDraft, null, null, null, -1, observedSelector.accessibleName);
            receipts.Add(collapsed);
            if (!collapsed.submitted)
            {
                result.outcome = receipts.Any(receipt => receipt.attempted || receipt.submitted) ? "submitted" : "blocked";
                result.reason = "native-collapse-not-confirmed";
                result.patternReceipts = receipts.ToArray();
                result.models = new string[0];
                return result;
            }
            Result finalSnapshot;
            ControlSummary finalSelector, finalComposer;
            int finalState;
            if (!FreshModelFrameMatches(hwnd, currentModel, initialDraft, out finalSnapshot, out finalSelector, out finalComposer, out finalState) || finalState != 0)
            {
                result.outcome = "submitted";
                result.reason = "native-collapse-postcondition-unverified";
                result.patternReceipts = receipts.ToArray();
                return result;
            }
            result.finalDraftFingerprint = finalComposer.draftFingerprint;
            result.finallyExpanded = false;
            result.patternReceipts = receipts.ToArray();
            if (result.models.Length == 0) { return result; }
            result.outcome = "confirmed";
            result.reason = null;
            return result;
        }

        Result finalExpandedSnapshot;
        ControlSummary finalExpandedSelector, finalExpandedComposer;
        int finalExpandedState;
        if (!FreshModelFrameMatches(hwnd, currentModel, initialDraft, out finalExpandedSnapshot, out finalExpandedSelector, out finalExpandedComposer, out finalExpandedState) || finalExpandedState != 1)
        { result.outcome = "submitted"; result.reason = "expanded-native-model-frame-changed"; return result; }
        result.finalDraftFingerprint = finalExpandedComposer.draftFingerprint;
        result.finallyExpanded = true;
        ApplyModelPopupInspection(result, InspectModelPopup(initial, finalExpandedSnapshot, currentModel), false);
        if (result.models.Length == 0) { return result; }
        result.patternReceipts = receipts.ToArray();
        result.outcome = "confirmed";
        result.reason = null;
        return result;
    }

    private static Result InspectInternal(IntPtr hwnd, int maxControls, bool allowContext, int maxNodes, int timeBudgetMs, bool lightweight,
        string identityTitle, string[][] identityAnchorCandidates)
    {
        Result result = new Result { status = new Status {
            typeHistogram = new string[0], providerClassHistogram = new string[0], providerDescriptionClass = "empty",
            providerDescriptionQueryHresult = unchecked((int)0x80004005),
            legacyIAccessiblePatternQueryHresult = unchecked((int)0x80004005),
            errorType = null, errorStage = String.Empty
        }, controls = new ControlSummary[0] };
        Status status = result.status;
        Stopwatch clock = Stopwatch.StartNew();
        WorkBuddyIUIAutomation automation = null;
        WorkBuddyIUIAutomationTreeWalker walker = null;
        WorkBuddyIUIAutomationElement root = null;
        List<ControlSummary> controls = new List<ControlSummary>();
        List<Node> summarizedNodes = new List<Node>();
        List<Node> traversedNodeRefs = new List<Node>();
        Dictionary<int, int> typeCounts = new Dictionary<int, int>();
        Dictionary<string, int> providerClassCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        Dictionary<string, int> nodeTypeByPath = new Dictionary<string, int>(StringComparer.Ordinal);
        Queue<Node> queue = new Queue<Node>();
        HashSet<long> identities = new HashSet<long>();
        try
        {
            status.errorStage = "activate-com";
            object coclass = Activator.CreateInstance(typeof(WorkBuddyCUIAutomation8));
            automation = (WorkBuddyIUIAutomation)coclass;
            status.comActivated = automation != null;
            status.activationHresult = 0;
            status.errorStage = "element-from-handle";
            status.elementFromHandleHresult = automation.ElementFromHandle(hwnd, out root);
            if (status.elementFromHandleHresult < 0 || root == null) return result;
            status.uiaWindowRootRetrieved = true;
            try { status.rootControlTypeId = Convert.ToInt32(Property(root, ControlTypePropertyId), CultureInfo.InvariantCulture); } catch { }
            if (!lightweight)
            {
                string rootProviderClass;
                status.providerDescriptionQueryHresult = QueryProviderDescription(root, out rootProviderClass);
                status.providerDescriptionClass = rootProviderClass;
                bool rootLegacyPattern;
                status.legacyIAccessiblePatternQueryHresult = ProbePattern(root, LegacyIAccessiblePatternId, out rootLegacyPattern);
                status.legacyIAccessiblePatternAvailable = rootLegacyPattern;
                status.legacyIAccessiblePatternNodes = rootLegacyPattern ? 1 : 0;
            }
            status.errorStage = "raw-view-walker";
            status.rawWalkerHresult = automation.get_RawViewWalker(out walker);
            if (status.rawWalkerHresult < 0 || walker == null) return result;
            queue.Enqueue(new Node { Element = root, Depth = 0, Index = 0, Path = "root", RegionPath = "root" });
            while (queue.Count > 0 && status.traversedNodes < maxNodes && clock.ElapsedMilliseconds < timeBudgetMs)
            {
                Node node = queue.Dequeue();
                long identity = 0;
                try
                {
                    IntPtr unknown = Marshal.GetIUnknownForObject(node.Element);
                    identity = unknown.ToInt64();
                    Marshal.Release(unknown);
                }
                catch { }
                if (identity != 0 && !identities.Add(identity)) continue;
                status.traversedNodes++;
                traversedNodeRefs.Add(node);
                int currentTypeId = 0;
                try
                {
                    currentTypeId = Convert.ToInt32(Property(node.Element, ControlTypePropertyId), CultureInfo.InvariantCulture);
                    nodeTypeByPath[node.Path] = currentTypeId;
                    if (!typeCounts.ContainsKey(currentTypeId)) typeCounts[currentTypeId] = 0;
                    typeCounts[currentTypeId]++;
                }
                catch { }
                if (!lightweight)
                {
                    string providerClass;
                    int providerHr = QueryProviderDescription(node.Element, out providerClass);
                    if (providerHr >= 0)
                    {
                        status.providerClassQueryCount++;
                        if (!providerClassCounts.ContainsKey(providerClass)) providerClassCounts[providerClass] = 0;
                        providerClassCounts[providerClass]++;
                    }
                    bool hasLegacyPattern;
                    int legacyHr = ProbePattern(node.Element, LegacyIAccessiblePatternId, out hasLegacyPattern);
                    if (legacyHr >= 0 && hasLegacyPattern) status.legacyIAccessiblePatternNodes++;
                }
                if (node.Depth > 0 && controls.Count < maxControls)
                {
                    ControlSummary summary = Summarize(node, allowContext, lightweight);
                    if (summary != null && summary.controlType == "ControlType.TabItem" && summary.safeActionLabel == "new-task-tab")
                    {
                        string parentPath = node.Path.Contains("/") ? node.Path.Substring(0, node.Path.LastIndexOf('/')) : String.Empty;
                        int parentType;
                        if (nodeTypeByPath.TryGetValue(parentPath, out parentType) && parentType == 50018)
                            summary.identityRole = "new-task-navigation-tab";
                    }
                    if (summary != null) { controls.Add(summary); summarizedNodes.Add(node); }
                }
                if (node.Depth >= 32) continue;
                WorkBuddyIUIAutomationElement child = null;
                int childHr = walker.GetFirstChildElement(node.Element, out child);
                if (childHr < 0 || child == null) continue;
                int index = 0;
                while (child != null && index < maxNodes && queue.Count < maxNodes && clock.ElapsedMilliseconds < timeBudgetMs)
                {
                    string childPath = node.Path + "/" + index.ToString(CultureInfo.InvariantCulture);
                    string childRegion = currentTypeId == 50030 ? childPath : node.RegionPath;
                    queue.Enqueue(new Node { Element = child, Depth = node.Depth + 1, Index = index, Path = childPath, RegionPath = childRegion });
                    WorkBuddyIUIAutomationElement next = null;
                    int nextHr = walker.GetNextSiblingElement(child, out next);
                    if (nextHr < 0) break;
                    child = next;
                    index++;
                }
            }
            status.traversalTruncated = queue.Count > 0 || status.traversedNodes >= maxNodes || clock.ElapsedMilliseconds >= timeBudgetMs;
            if (allowContext && !status.traversalTruncated)
            {
                status.composerBindingAttempted = true;
                List<int> editIndexes = new List<int>();
                List<int> modelIndexes = new List<int>();
                List<int> sendIndexes = new List<int>();
                for (int i = 0; i < controls.Count; i++)
                {
                    ControlSummary item = controls[i];
                    if (item.passwordProtected || item.offscreen) continue;
                    if (item.controlType == "ControlType.Edit" && !item.passwordProtected && item.enabled) editIndexes.Add(i);
                    else if (item.safeActionLabel == "model-selector" && item.enabled) modelIndexes.Add(i);
                    else if (item.safeActionLabel == "send-label") sendIndexes.Add(i);
                }
                status.composerEditCandidates = editIndexes.Count;
                status.composerModelCandidates = modelIndexes.Count;
                status.composerSendCandidates = sendIndexes.Count;
                if (editIndexes.Count == 1 && modelIndexes.Count == 1 && sendIndexes.Count == 1)
                {
                    ControlSummary edit = controls[editIndexes[0]];
                    ControlSummary model = controls[modelIndexes[0]];
                    ControlSummary send = controls[sendIndexes[0]];
                    int groupDepth;
                    string groupPath = CommonAncestorPath(summarizedNodes[editIndexes[0]].Path,
                        summarizedNodes[modelIndexes[0]].Path, summarizedNodes[sendIndexes[0]].Path, out groupDepth);
                    int groupTypeId;
                    bool groupTypeKnown = nodeTypeByPath.TryGetValue(groupPath, out groupTypeId);
                    status.composerGroupDepth = groupDepth;
                    status.composerGroupTypeId = groupTypeKnown ? groupTypeId : 0;
                    if (groupDepth >= 3 && groupTypeKnown && (groupTypeId == 50033 || groupTypeId == 50026))
                    {
                        string region = Hash(groupPath);
                        edit.regionHash = region;
                        model.regionHash = region;
                        send.regionHash = region;
                        ReadBoundComposerDraft(edit, summarizedNodes[editIndexes[0]], !send.enabled);
                        status.composerBindingSucceeded = edit.draftState != "unavailable";
                    }
                }

                // Catalog options are projected only when they are actual
                // ListItem descendants of a uniquely identified native model
                // or workspace selector. This excludes unrelated history and
                // permission/profile lists from the model/project catalogs.
                List<int> modelSelectorIndexes = new List<int>();
                List<int> workspaceSelectorIndexes = new List<int>();
                for (int i = 0; i < controls.Count; i++)
                {
                    if (controls[i].safeActionLabel == "model-selector") modelSelectorIndexes.Add(i);
                    else if (controls[i].safeActionLabel == "workspace-selector") workspaceSelectorIndexes.Add(i);
                }
                if (lightweight && modelSelectorIndexes.Count == 1 && workspaceSelectorIndexes.Count <= 1)
                {
                    int modelIndex = modelSelectorIndexes[0];
                    Node modelNode = summarizedNodes[modelIndex];
                    string modelPrefix = modelNode.Path + "/";
                    foreach (Node candidate in traversedNodeRefs)
                    {
                        if (candidate.Depth <= modelNode.Depth || candidate.Depth > modelNode.Depth + 8 || !candidate.Path.StartsWith(modelPrefix, StringComparison.Ordinal)) continue;
                        int typeId;
                        if (!nodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50007) continue;
                        ControlSummary option = SummarizeCatalogOption(candidate, "model-option", controls[modelIndex].regionHash);
                        if (option != null) { controls.Add(option); summarizedNodes.Add(candidate); }
                        if (controls.Count >= maxControls) break;
                    }
                }
                if (lightweight && workspaceSelectorIndexes.Count == 1 && modelSelectorIndexes.Count <= 1 && controls.Count < maxControls)
                {
                    int workspaceIndex = workspaceSelectorIndexes[0];
                    Node workspaceNode = summarizedNodes[workspaceIndex];
                    string workspacePrefix = workspaceNode.Path + "/";
                    foreach (Node candidate in traversedNodeRefs)
                    {
                        if (candidate.Depth <= workspaceNode.Depth || candidate.Depth > workspaceNode.Depth + 8 || !candidate.Path.StartsWith(workspacePrefix, StringComparison.Ordinal)) continue;
                        int typeId;
                        if (!nodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50007) continue;
                        ControlSummary option = SummarizeCatalogOption(candidate, "workspace-option", controls[workspaceIndex].regionHash);
                        if (option != null) { controls.Add(option); summarizedNodes.Add(candidate); }
                        if (controls.Count >= maxControls) break;
                    }
                }
            }
            if (allowContext && !status.traversalTruncated && !String.IsNullOrEmpty(identityTitle) && identityAnchorCandidates != null)
            {
                List<Node> rowNodes = new List<Node>();
                List<Node> sidebarNodes = new List<Node>();
                List<Node> headerNodes = new List<Node>();
                foreach (Node candidate in traversedNodeRefs)
                {
                    int typeId;
                    if (!nodeTypeByPath.TryGetValue(candidate.Path, out typeId)) continue;
                    if (typeId == 50000 && BoolProperty(candidate.Element, EnabledPropertyId) && !BoolProperty(candidate.Element, OffscreenPropertyId))
                    {
                        string rowTitle = ConversationRowTitle(SafeName(Property(candidate.Element, NamePropertyId)));
                        if (IsSidebarConversationCard(candidate)) {
                            sidebarNodes.Add(candidate);
                            bool titleChild = traversedNodeRefs.Any(n => n.Depth > candidate.Depth && n.Path.StartsWith(candidate.Path + "/", StringComparison.Ordinal) &&
                                nodeTypeByPath.ContainsKey(n.Path) && nodeTypeByPath[n.Path] == 50020 && SafeName(Property(n.Element, NamePropertyId)) == identityTitle);
                            if (titleChild) rowNodes.Add(candidate);
                        } else if (String.Equals(rowTitle, identityTitle, StringComparison.Ordinal)) {
                            rowNodes.Add(candidate); sidebarNodes.Add(candidate);
                        }
                    }
                }
                foreach (Node candidate in traversedNodeRefs)
                {
                    int typeId;
                    if (!nodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50020 || BoolProperty(candidate.Element, OffscreenPropertyId)) continue;
                    string text = SafeName(Property(candidate.Element, NamePropertyId));
                    if (!String.Equals(text, identityTitle, StringComparison.Ordinal)) continue;
                    bool insideRow = sidebarNodes.Any(row => candidate.Path.StartsWith(row.Path + "/", StringComparison.Ordinal));
                    if (!insideRow) headerNodes.Add(candidate);
                }
                if (headerNodes.Count == 1) {
                    // RegionPath is a derived UIA structural scope. Narrow it
                    // to this native conversation view, excluding sidebar and
                    // other grid panes while retaining the actual node paths.
                    string surface = ConversationSurfacePath(traversedNodeRefs, headerNodes[0]);
                    if (!String.IsNullOrEmpty(surface)) foreach (Node node in traversedNodeRefs)
                        if (node.Path == surface || node.Path.StartsWith(surface + "/", StringComparison.Ordinal)) node.RegionPath = surface;
                }
                List<int> matchingCandidateIndexes = new List<int>();
                for (int candidateIndex = 0; candidateIndex < identityAnchorCandidates.Length; candidateIndex++)
                {
                    string[] anchors = identityAnchorCandidates[candidateIndex] ?? new string[0];
                    bool allFound = headerNodes.Count == 1 && anchors.Length > 0;
                    foreach (string anchor in anchors)
                    {
                        bool found = false;
                        if (allFound)
                        {
                            string headerRegion = headerNodes[0].RegionPath;
                            foreach (Node candidate in traversedNodeRefs)
                            {
                                int typeId;
                                if (!nodeTypeByPath.TryGetValue(candidate.Path, out typeId) || typeId != 50020 ||
                                    !String.Equals(candidate.RegionPath, headerRegion, StringComparison.Ordinal)) continue;
                                string visibleText = SafeMessageAnchorText(Property(candidate.Element, NamePropertyId));
                                if (visibleText.IndexOf(anchor, StringComparison.Ordinal) >= 0) { found = true; break; }
                            }
                        }
                        if (!found) { allFound = false; break; }
                    }
                    if (allFound) matchingCandidateIndexes.Add(candidateIndex);
                }
                result.identityProof = new ConversationIdentityProof {
                    conversationRowMatches = rowNodes.Count,
                    conversationHeaderMatches = headerNodes.Count,
                    candidateCount = identityAnchorCandidates.Length,
                    matchedCandidateIndex = matchingCandidateIndexes.Count == 1 ? matchingCandidateIndexes[0] : -1
                };
            }
            List<string> histogram = new List<string>();
            foreach (KeyValuePair<int, int> entry in typeCounts) histogram.Add(entry.Key.ToString(CultureInfo.InvariantCulture) + ":" + entry.Value.ToString(CultureInfo.InvariantCulture));
            status.typeHistogram = histogram.ToArray();
            List<string> providerHistogram = new List<string>();
            foreach (KeyValuePair<string, int> entry in providerClassCounts) providerHistogram.Add(entry.Key + ":" + entry.Value.ToString(CultureInfo.InvariantCulture));
            status.providerClassHistogram = providerHistogram.ToArray();
            status.errorStage = String.Empty;
        }
        catch (Exception ex)
        {
            status.errorType = ex.GetType().Name;
        }
        finally
        {
            clock.Stop();
            status.elapsedMs = (int)Math.Min(Int32.MaxValue, clock.ElapsedMilliseconds);
            result.controls = controls.ToArray();
            result.NodeReferences = summarizedNodes.ToArray();
            result.AllNodeReferences = status.traversalTruncated ? new Node[0] : traversedNodeRefs.ToArray();
            result.NodeTypeByPath = nodeTypeByPath;
            if (root != null && Marshal.IsComObject(root)) { try { Marshal.ReleaseComObject(root); } catch { } }
            if (walker != null && Marshal.IsComObject(walker)) { try { Marshal.ReleaseComObject(walker); } catch { } }
            if (automation != null && Marshal.IsComObject(automation)) { try { Marshal.ReleaseComObject(automation); } catch { } }
        }
        return result;
    }

    public static Status InspectStatistics(IntPtr hwnd, int maxNodes, int timeBudgetMs)
    {
        return InspectInternal(hwnd, 0, false, maxNodes, timeBudgetMs, false, null, null).status;
    }
}
