using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

public static partial class WorkBuddyWindowsUiaComProbe
{
    private const int PendingMaxForms = 8;
    private const int PendingMaxControls = 128;
    private const int PendingMaxTextControls = 32;
    private const int PendingMaxQuestionOptions = 12;
    private const int PendingMaxOptionLabel = 200;
    private const int PendingMaxQuestionText = 8192;
    private const int PendingMaxCommandText = 4000;

    private static readonly Regex PendingCredentialPattern = new Regex(
        @"(?i)\b(?:Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    // Ellipses are valid prompt/command content. Only explicit native/provider
    // truncation markers (or a measured size bound below) indicate truncation.
    private static readonly Regex PendingTruncationPattern = new Regex(
        @"(?i)\[(?:native\s+)?(?:truncated|cut off)\]",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public sealed class PendingFormsResult
    {
        public bool snapshotComplete { get; set; }
        public bool conversationIdentityVerified { get; set; }
        public string reason { get; set; }
        public PendingFormDescriptor[] forms { get; set; }
    }

    public sealed class PendingFormDescriptor
    {
        public string kind { get; set; }
        public bool complete { get; set; }
        public bool desktopGuide { get; set; }
        public string conversationRegionHash { get; set; }
        public string scopePathHash { get; set; }
        public string visibleText { get; set; }
        public string commandText { get; set; }
        public int? pageIndex { get; set; }
        public int? pageCount { get; set; }
        public string questionIndexSource { get; set; }
        public int? selectedCount { get; set; }
        public string selectedCountSource { get; set; }
        public PendingControlDescriptor[] controls { get; set; }
    }

    public sealed class PendingControlDescriptor
    {
        public string controlType { get; set; }
        public string accessibleName { get; set; }
        public bool enabled { get; set; }
        public string[] patterns { get; set; }
        public string pathHash { get; set; }
        public string runtimeIdHash { get; set; }
        public string regionHash { get; set; }
        public bool passwordProtected { get; set; }
    }

    // Closed evidence shape used by the COM reader and by the compilation
    // fixture. It intentionally has no dictionaries, payload fields, or
    // request/turn identifiers.
    internal sealed class PendingFormEvidence
    {
        internal string kind;
        internal string scopePath;
        internal string regionPath;
        internal string visibleText;
        internal string commandText;
        internal PendingControlDescriptor[] controls;
        internal bool uniqueScope;
        internal bool completeSignature;
        internal bool completeText;
        internal bool textTruncated;
        internal bool containsCredential;
        internal bool hasPasswordField;
        internal bool hasUnexpectedEdit;
        internal bool hasUnsupportedDecision;
    }

    internal sealed class PendingScopeEvidence
    {
        internal string kind;
        internal string scopePath;
        internal int previousCount;
        internal int nextCount;
        internal int sendCount;
        internal int runCount;
        internal int skipCount;
        internal int rejectCount;
    }

    private sealed class PendingNodeName
    {
        internal Node node;
        internal int typeId;
        internal bool offscreenKnown;
        internal bool offscreen;
        internal bool enabledKnown;
        internal bool enabled;
        internal bool passwordKnown;
        internal bool password;
        internal bool nameRead;
        internal bool nameValid;
        internal bool sensitive;
        internal bool textTruncated;
        internal string name;
    }

    private static PendingFormsResult PendingFailure(bool snapshotComplete, bool identityVerified, string reason)
    {
        return new PendingFormsResult {
            snapshotComplete = snapshotComplete,
            conversationIdentityVerified = identityVerified,
            reason = reason,
            forms = new PendingFormDescriptor[0]
        };
    }

    private static bool PendingHashIsValid(string value)
    {
        return !String.IsNullOrEmpty(value) && Regex.IsMatch(value, "^[a-f0-9]{16}$", RegexOptions.CultureInvariant);
    }

    private static bool PendingContainsSensitiveText(string value)
    {
        return !String.IsNullOrEmpty(value) && PendingCredentialPattern.IsMatch(value);
    }

    internal static bool HasPendingTextTruncationEvidence(string value, int maxLength)
    {
        return !String.IsNullOrEmpty(value) &&
            (value.Length > maxLength || PendingTruncationPattern.IsMatch(value));
    }

    private static string PendingNormalizeVisibleText(string value, int maxLength)
    {
        if (value == null || value.Length == 0 || value.Length > maxLength ||
            PendingTruncationPattern.IsMatch(value) || PendingContainsSensitiveText(value)) return null;
        foreach (char character in value)
        {
            if (Char.IsControl(character) && character != '\r' && character != '\n' && character != '\t') return null;
        }
        string normalized = value.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        return normalized.Length > 0 && normalized.Length <= maxLength ? normalized : null;
    }

    private static bool PendingIsActionControl(PendingControlDescriptor control)
    {
        return control != null &&
            (control.controlType == "ControlType.Button" ||
             control.controlType == "ControlType.ListItem" ||
             control.controlType == "ControlType.Edit");
    }

    private static bool PendingControlEvidenceIsSafe(PendingControlDescriptor[] controls, string regionHash)
    {
        if (controls == null || controls.Length == 0 || controls.Length > PendingMaxControls) return false;
        HashSet<string> runtimeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (PendingControlDescriptor control in controls)
        {
            if (control == null || String.IsNullOrEmpty(control.controlType) ||
                control.controlType.Length > 64 || control.passwordProtected ||
                !PendingHashIsValid(control.pathHash) || !String.Equals(control.regionHash, regionHash, StringComparison.Ordinal) ||
                control.patterns == null || control.patterns.Length > 6) return false;
            if (control.accessibleName != null &&
                (control.accessibleName.Length > 256 || PendingContainsSensitiveText(control.accessibleName))) return false;
            if (PendingIsActionControl(control))
            {
                if (!PendingHashIsValid(control.runtimeIdHash) || !runtimeIds.Add(control.runtimeIdHash) ||
                    control.accessibleName == null || control.accessibleName.Length == 0) return false;
            }
            else if (!String.IsNullOrEmpty(control.runtimeIdHash) && !PendingHashIsValid(control.runtimeIdHash)) return false;
            foreach (string pattern in control.patterns)
            {
                if (pattern != "invoke" && pattern != "selectionItem" && pattern != "toggle" &&
                    pattern != "value" && pattern != "text" && pattern != "expandCollapse") return false;
            }
        }
        return true;
    }

    // This is the single projection gate: incomplete or sensitive evidence
    // never carries action controls or the underlying text into the result.
    internal static PendingFormsResult ProjectPendingFormsEvidence(
        bool snapshotComplete, bool conversationIdentityVerified, PendingFormEvidence[] evidence)
    {
        if (!snapshotComplete) return PendingFailure(false, false, "snapshot-incomplete");
        if (!conversationIdentityVerified) return PendingFailure(true, false, "conversation-identity-unverified");
        if (evidence == null || evidence.Length > PendingMaxForms)
            return PendingFailure(true, true, "form-count-out-of-bounds");

        List<PendingFormDescriptor> forms = new List<PendingFormDescriptor>();
        Dictionary<string, int> scopeCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (PendingFormEvidence candidate in evidence)
        {
            if (candidate == null || (candidate.kind != "question" && candidate.kind != "command") ||
                String.IsNullOrEmpty(candidate.scopePath)) continue;
            string key = candidate.kind + ":" + Hash(candidate.scopePath);
            if (!scopeCounts.ContainsKey(key)) scopeCounts[key] = 0;
            scopeCounts[key]++;
        }
        bool sawIncomplete = false;
        foreach (PendingFormEvidence item in evidence)
        {
            if (item == null || (item.kind != "question" && item.kind != "command"))
            {
                sawIncomplete = true;
                continue;
            }
            string scopeHash = String.IsNullOrEmpty(item.scopePath) ? String.Empty : Hash(item.scopePath);
            string regionHash = String.IsNullOrEmpty(item.regionPath) ? String.Empty : Hash(item.regionPath);
            string duplicateKey = item.kind + ":" + scopeHash;
            bool unique = item.uniqueScope && PendingHashIsValid(scopeHash) &&
                PendingHashIsValid(regionHash) && scopeCounts.ContainsKey(duplicateKey) &&
                scopeCounts[duplicateKey] == 1;
            string visibleText = null;
            string commandText = null;
            if (item.kind == "question")
            {
                visibleText = PendingNormalizeVisibleText(item.visibleText, PendingMaxQuestionText);
            }
            else
            {
                visibleText = PendingNormalizeVisibleText(item.visibleText, PendingMaxQuestionText);
                commandText = PendingNormalizeVisibleText(item.commandText, PendingMaxCommandText);
            }

            bool textSafe = item.completeText && !item.textTruncated && !item.containsCredential &&
                !(item.kind == "question" && String.IsNullOrEmpty(visibleText)) &&
                !(item.kind == "command" && (String.IsNullOrEmpty(visibleText) || String.IsNullOrEmpty(commandText)));
            bool controlsSafe = PendingControlEvidenceIsSafe(item.controls, regionHash);
            bool complete = unique && item.completeSignature && textSafe && controlsSafe &&
                !item.hasPasswordField && !item.hasUnexpectedEdit && !item.hasUnsupportedDecision;
            if (item.kind == "question" && complete)
            {
                int optionCount = item.controls.Count(control =>
                    (control.controlType == "ControlType.Button" || control.controlType == "ControlType.ListItem") &&
                    !IsQuestionNavigationLabel(control.accessibleName));
                if (optionCount > PendingMaxQuestionOptions ||
                    item.controls.Any(control =>
                        (control.controlType == "ControlType.Button" || control.controlType == "ControlType.ListItem") &&
                        !IsQuestionNavigationLabel(control.accessibleName) &&
                        (control.accessibleName == null || control.accessibleName.Length > PendingMaxOptionLabel)))
                    complete = false;
            }
            if (item.kind == "command" && complete && ContainsUnsupportedCommandDecision(item.controls))
                complete = false;

            if (!complete) sawIncomplete = true;
            int? pageIndex = null;
            int? pageCount = null;
            string questionIndexSource = "unavailable";
            int? selectedCount = null;
            string selectedCountSource = "unavailable";
            if (complete && item.kind == "question")
            {
                int observedIndex;
                int observedCount;
                if (TryReadNativeQuestionProgress(visibleText, out observedIndex, out observedCount))
                {
                    pageIndex = observedIndex;
                    pageCount = observedCount;
                    questionIndexSource = "native-progress";
                }
                int observedSelectedCount;
                if (TryReadNativeSelectedCount(visibleText, out observedSelectedCount))
                {
                    selectedCount = observedSelectedCount;
                    selectedCountSource = "native-visible-count";
                }
            }
            forms.Add(new PendingFormDescriptor {
                kind = item.kind,
                complete = complete,
                desktopGuide = !complete,
                conversationRegionHash = PendingHashIsValid(regionHash) ? regionHash : String.Empty,
                scopePathHash = PendingHashIsValid(scopeHash) && unique ? scopeHash : String.Empty,
                visibleText = complete && item.kind == "question" ? visibleText : String.Empty,
                commandText = complete && item.kind == "command" ? commandText : String.Empty,
                pageIndex = pageIndex,
                pageCount = pageCount,
                questionIndexSource = questionIndexSource,
                selectedCount = selectedCount,
                selectedCountSource = selectedCountSource,
                controls = complete ? item.controls : new PendingControlDescriptor[0]
            });
        }
        if (forms.Count == 0)
            return new PendingFormsResult {
                snapshotComplete = true, conversationIdentityVerified = true,
                reason = evidence.Length == 0 ? "no-visible-pending-form" : "form-evidence-invalid",
                forms = new PendingFormDescriptor[0]
            };
        return new PendingFormsResult {
            snapshotComplete = true,
            conversationIdentityVerified = true,
            reason = sawIncomplete ? "desktop-guide-required" : null,
            forms = forms.ToArray()
        };
    }

    private static bool IsQuestionNavigationLabel(string name)
    {
        return String.Equals(name, "Previous question", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "Next question", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "Send", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "\u4E0A\u4E00\u9898", StringComparison.Ordinal) ||
            String.Equals(name, "\u4E0B\u4E00\u9898", StringComparison.Ordinal) ||
            String.Equals(name, "\u53D1\u9001", StringComparison.Ordinal);
    }

    private static bool TryReadNativeQuestionProgress(string visibleText, out int pageIndex, out int pageCount)
    {
        pageIndex = 0;
        pageCount = 0;
        if (String.IsNullOrEmpty(visibleText)) return false;
        MatchCollection matches = Regex.Matches(visibleText, @"(?m)^\s*([1-9][0-9]{0,2})/([1-9][0-9]{0,2})\s*$", RegexOptions.CultureInvariant);
        if (matches.Count != 1) return false;
        int index;
        int count;
        if (!Int32.TryParse(matches[0].Groups[1].Value, out index) ||
            !Int32.TryParse(matches[0].Groups[2].Value, out count) ||
            index < 1 || count < 1 || index > count || count > 8) return false;
        pageIndex = index;
        pageCount = count;
        return true;
    }

    private static bool TryReadNativeSelectedCount(string visibleText, out int selectedCount)
    {
        selectedCount = 0;
        if (String.IsNullOrEmpty(visibleText)) return false;
        MatchCollection matches = Regex.Matches(visibleText,
            @"(?m)^\s*(?:\u5DF2\u9009\u62E9\s*([0-9]{1,3})\s*\u4E2A|([0-9]{1,3})\s+selected)\s*$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (matches.Count != 1) return false;
        string value = matches[0].Groups[1].Success ? matches[0].Groups[1].Value : matches[0].Groups[2].Value;
        int count;
        if (!Int32.TryParse(value, out count) || count > PendingMaxQuestionOptions) return false;
        selectedCount = count;
        return true;
    }

    private static bool ContainsUnsupportedCommandDecision(PendingControlDescriptor[] controls)
    {
        string[] unsupported = { "Always", "Always allow", "Allow once", "Allow for this session", "Approve", "Approve session", "\u5141\u8BB8", "\u672C\u6B21\u4F1A\u8BDD\u59CB\u7EC8\u5141\u8BB8" };
        return controls != null && controls.Any(control => control != null &&
            (control.controlType == "ControlType.Button" || control.controlType == "ControlType.ListItem") &&
            unsupported.Any(label => String.Equals(control.accessibleName, label, StringComparison.OrdinalIgnoreCase)));
    }

    private static string TwoPathCommonAncestor(string first, string second)
    {
        if (String.IsNullOrEmpty(first) || String.IsNullOrEmpty(second)) return String.Empty;
        string[] left = first.Split('/');
        string[] right = second.Split('/');
        int count = Math.Min(left.Length, right.Length);
        int shared = 0;
        while (shared < count && String.Equals(left[shared], right[shared], StringComparison.Ordinal)) shared++;
        return shared == 0 ? String.Empty : String.Join("/", left, 0, shared);
    }

    private static bool IsDescendantOrSelf(Node node, Node parent)
    {
        return node != null && parent != null &&
            (String.Equals(node.Path, parent.Path, StringComparison.Ordinal) ||
             node.Path.StartsWith(parent.Path + "/", StringComparison.Ordinal));
    }

    private static bool ReadKnownBoolean(Node node, int propertyId, out bool value)
    {
        value = false;
        if (node == null || node.Element == null || !HelperBudgetReady()) return false;
        object raw = Property(node.Element, propertyId);
        if (!(raw is bool)) return false;
        value = (bool)raw;
        return true;
    }

    private static PendingNodeName ReadPendingNodeName(Node node, int typeId, bool readName)
    {
        PendingNodeName item = new PendingNodeName { node = node, typeId = typeId };
        if (node == null || node.Element == null || !HelperBudgetReady()) return item;
        item.offscreenKnown = ReadKnownBoolean(node, OffscreenPropertyId, out item.offscreen);
        item.enabledKnown = ReadKnownBoolean(node, EnabledPropertyId, out item.enabled);
        bool signatureButton = typeId == 50000 || typeId == 50007;
        if (typeId == 50004 && readName)
        {
            item.passwordKnown = ReadKnownBoolean(node, IsPasswordPropertyId, out item.password);
            if (!item.passwordKnown || item.password) return item;
        }
        if (!readName && !signatureButton) return item;
        if (!item.offscreenKnown || item.offscreen || !item.enabledKnown || !HelperBudgetReady()) return item;
        object rawValue = Property(node.Element, NamePropertyId);
        item.nameRead = true;
        string raw = rawValue as string;
        if (raw == null || raw.Length == 0 ||
            HasPendingTextTruncationEvidence(raw, PendingMaxCommandText) ||
            PendingCredentialPattern.IsMatch(raw))
        {
            item.textTruncated = HasPendingTextTruncationEvidence(raw, PendingMaxCommandText);
            item.sensitive = raw != null && PendingContainsSensitiveText(raw);
            item.nameValid = false;
            return item;
        }
        foreach (char character in raw)
        {
            if (Char.IsControl(character) && character != '\r' && character != '\n' && character != '\t')
            {
                item.nameValid = false;
                return item;
            }
        }
        item.name = raw.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        item.nameValid = item.name.Length > 0 && item.name.Length <= PendingMaxCommandText;
        return item;
    }

    private static bool PendingNameEquals(PendingNodeName item, string expected)
    {
        return item != null && item.nameValid &&
            String.Equals(item.name, expected, StringComparison.OrdinalIgnoreCase);
    }

    private static string PendingButtonKind(PendingNodeName item)
    {
        if (item == null || !item.nameValid) return String.Empty;
        if (item.typeId != 50000 && item.typeId != 50007) return String.Empty;
        if (PendingNameEquals(item, "Previous question") || PendingNameEquals(item, "\u4E0A\u4E00\u9898")) return "previous";
        if (PendingNameEquals(item, "Next question") || PendingNameEquals(item, "\u4E0B\u4E00\u9898")) return "next";
        if (PendingNameEquals(item, "Send") || PendingNameEquals(item, "\u53D1\u9001")) return "send";
        if (PendingNameEquals(item, "Run") || PendingNameEquals(item, "\u8FD0\u884C") || PendingNameEquals(item, "\u57F7\u884C")) return "run";
        if (PendingNameEquals(item, "Skip") || PendingNameEquals(item, "\u8DF3\u8FC7") || PendingNameEquals(item, "\u8DF3\u904E")) return "skip";
        if (PendingNameEquals(item, "Reject") || PendingNameEquals(item, "\u62D2\u7EDD") || PendingNameEquals(item, "\u62D2\u7D55")) return "reject";
        if (PendingNameEquals(item, "Always") || PendingNameEquals(item, "Always allow") ||
            PendingNameEquals(item, "Allow once") || PendingNameEquals(item, "Allow for this session") ||
            PendingNameEquals(item, "Approve") || PendingNameEquals(item, "Approve session") ||
            PendingNameEquals(item, "\u5141\u8BB8") || PendingNameEquals(item, "\u672C\u6B21\u4F1A\u8BDD\u59CB\u7EC8\u5141\u8BB8")) return "unsupported-decision";
        return String.Empty;
    }

    private static bool IsQuestionEditPlaceholder(PendingNodeName item)
    {
        return item != null && item.typeId == 50004 && item.nameValid &&
            (String.Equals(item.name, "Other (type your answer)", StringComparison.OrdinalIgnoreCase) ||
             String.Equals(item.name, "\u5176\u4ED6\uFF08\u8F93\u5165\u4F60\u7684\u7B54\u6848\uFF09", StringComparison.Ordinal));
    }

    private static List<string> ReadPendingPatterns(Node node, ref bool complete)
    {
        List<string> patterns = new List<string>();
        int[] ids = { InvokePatternId, SelectionItemPatternId, TogglePatternId, ValuePatternId, TextPatternId, ExpandCollapsePatternId };
        string[] names = { "invoke", "selectionItem", "toggle", "value", "text", "expandCollapse" };
        for (int index = 0; index < ids.Length; index++)
        {
            if (!HelperBudgetReady())
            {
                complete = false;
                break;
            }
            if (HasPattern(node.Element, ids[index])) patterns.Add(names[index]);
        }
        return patterns;
    }

    private static bool IsPresentationLabel(string value)
    {
        return String.Equals(value, "bash", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(value, "powershell", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(value, "command", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(value, "command to run", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(value, "run this command", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(value, "run this command?", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryBuildPendingControls(
        List<PendingNodeName> scoped, string regionPath, string kind,
        out PendingControlDescriptor[] controls, out string visibleText, out string commandText,
        out bool completeText, out bool containsCredential, out bool hasPassword,
        out bool hasUnexpectedEdit, out bool hasUnsupportedDecision, out bool textTruncated)
    {
        controls = new PendingControlDescriptor[0];
        visibleText = String.Empty;
        commandText = String.Empty;
        completeText = true;
        containsCredential = false;
        hasPassword = false;
        hasUnexpectedEdit = false;
        hasUnsupportedDecision = false;
        textTruncated = false;
        if (scoped == null || scoped.Count == 0 || scoped.Count > PendingMaxControls)
        {
            completeText = false;
            return false;
        }

        List<string> textNames = new List<string>();
        List<string> questionNames = new List<string>();
        List<PendingControlDescriptor> result = new List<PendingControlDescriptor>();
        HashSet<string> runtimeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (PendingNodeName item in scoped)
        {
            if (item.textTruncated) textTruncated = true;
            if (!item.offscreenKnown || item.offscreen || !item.enabledKnown)
            {
                completeText = false;
                continue;
            }
            if (item.typeId == 50004)
            {
                if (!item.passwordKnown || item.password)
                {
                    hasPassword = true;
                    completeText = false;
                    continue;
                }
                if (!item.nameRead || !item.nameValid || !IsQuestionEditPlaceholder(item))
                {
                    hasUnexpectedEdit = true;
                    completeText = false;
                    continue;
                }
            }
            if (item.typeId == 50020)
            {
                if (!item.nameRead || !item.nameValid || textNames.Count >= PendingMaxTextControls)
                {
                    completeText = false;
                    continue;
                }
                textNames.Add(item.name);
            }
            else if (item.typeId == 50000 || item.typeId == 50007)
            {
                if (!item.nameRead || !item.nameValid || item.name.Length > 256)
                {
                    completeText = false;
                    continue;
                }
                string buttonKind = PendingButtonKind(item);
                if (buttonKind == "unsupported-decision") hasUnsupportedDecision = true;
                if (kind == "question" && !IsQuestionNavigationLabel(item.name))
                    questionNames.Add(item.name);
            }

            bool shouldProject = item.typeId == 50000 || item.typeId == 50007 ||
                item.typeId == 50004 || item.typeId == 50020;
            if (!shouldProject) continue;
            if (!item.nameRead || !item.nameValid || item.sensitive)
            {
                containsCredential = containsCredential || item.sensitive;
                completeText = false;
                continue;
            }
            string controlType = TypeName(item.typeId);
            if (String.IsNullOrEmpty(controlType))
            {
                completeText = false;
                continue;
            }
            string runtimeHash = RuntimeIdHash(item.node.Element);
            bool actionControl = item.typeId == 50000 || item.typeId == 50007 || item.typeId == 50004;
            if (actionControl && (!PendingHashIsValid(runtimeHash) || !runtimeIds.Add(runtimeHash)))
                completeText = false;
            List<string> patterns = ReadPendingPatterns(item.node, ref completeText);
            if (actionControl && (item.typeId == 50000 || item.typeId == 50007) &&
                !patterns.Contains("invoke") && !patterns.Contains("selectionItem") && !patterns.Contains("toggle"))
                completeText = false;
            if (item.typeId == 50004 && !patterns.Contains("value"))
                completeText = false;
            result.Add(new PendingControlDescriptor {
                controlType = controlType,
                accessibleName = item.typeId == 50020 ? null : item.name,
                enabled = item.enabled,
                patterns = patterns.ToArray(),
                pathHash = Hash(item.node.Path),
                runtimeIdHash = runtimeHash,
                regionHash = Hash(regionPath),
                passwordProtected = false
            });
        }

        if (textNames.Count == 0) completeText = false;
        if (kind == "question")
        {
            if (textNames.Count > 0)
                visibleText = String.Join("\n", textNames.Concat(questionNames).ToArray());
        }
        else
        {
            visibleText = String.Join("\n", textNames.ToArray());
            string[] commandParts = textNames.Where(value => !IsPresentationLabel(value)).ToArray();
            if (commandParts.Length == 1 &&
                commandParts[0].StartsWith("bash\n", StringComparison.OrdinalIgnoreCase))
            {
                commandText = commandParts[0].Substring(5).Trim();
            }
            else if (commandParts.Length == 1)
            {
                commandText = commandParts[0];
            }
            else if (commandParts.Length == 2 &&
                String.Equals(commandParts[0], "bash", StringComparison.OrdinalIgnoreCase))
            {
                commandText = commandParts[1];
            }
            else
            {
                completeText = false;
            }
        }

        if (result.Count == 0 || result.Count > PendingMaxControls) completeText = false;
        controls = result.ToArray();
        if (PendingContainsSensitiveText(visibleText) || PendingContainsSensitiveText(commandText))
        {
            containsCredential = true;
            completeText = false;
        }
        if (kind == "command" &&
            (String.IsNullOrEmpty(commandText) ||
             HasPendingTextTruncationEvidence(commandText, PendingMaxCommandText)))
        {
            textTruncated = textTruncated ||
                HasPendingTextTruncationEvidence(commandText, PendingMaxCommandText);
            completeText = false;
        }
        if (kind == "question" &&
            (String.IsNullOrEmpty(visibleText) ||
             HasPendingTextTruncationEvidence(visibleText, PendingMaxQuestionText)))
        {
            textTruncated = textTruncated ||
                HasPendingTextTruncationEvidence(visibleText, PendingMaxQuestionText);
            completeText = false;
        }
        if (textNames.Any(value => HasPendingTextTruncationEvidence(value, PendingMaxCommandText)))
        {
            textTruncated = true;
            completeText = false;
        }
        return completeText;
    }

    private static List<PendingNodeName> ScopedPendingNodes(
        Node scope, List<Node> regionNodes, Dictionary<string, int> types, bool readNames)
    {
        List<PendingNodeName> result = new List<PendingNodeName>();
        foreach (Node node in regionNodes)
        {
            if (!HelperBudgetReady()) return result;
            if (!IsDescendantOrSelf(node, scope)) continue;
            int typeId;
            if (!types.TryGetValue(node.Path, out typeId)) continue;
            if (typeId != 50000 && typeId != 50007 && typeId != 50004 && typeId != 50020) continue;
            PendingNodeName item = ReadPendingNodeName(node, typeId,
                readNames || typeId == 50000 || typeId == 50007);
            result.Add(item);
        }
        return result;
    }

    private static bool ScopeBelongsToConversation(
        Node header, Node scope, Dictionary<string, int> types)
    {
        string common = TwoPathCommonAncestor(header.Path, scope.Path);
        int typeId;
        return !String.IsNullOrEmpty(common) &&
            types.TryGetValue(common, out typeId) && (typeId == 50026 || typeId == 50033);
    }

    // Shared structural selector for the COM reader and its native-shape
    // fixture: prefer the deepest Group/Pane containing exactly one full
    // native form signature. Partial signatures are guide-only candidates.
    internal static string[] SelectClosestPendingScopePaths(
        PendingScopeEvidence[] scopes, string kind, bool completeOnly)
    {
        if (scopes == null || scopes.Length > 512 || (kind != "question" && kind != "command"))
            return new string[0];
        List<string> candidates = new List<string>();
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (PendingScopeEvidence scope in scopes)
        {
            if (scope == null || scope.kind != kind || String.IsNullOrEmpty(scope.scopePath) ||
                new[] { scope.previousCount, scope.nextCount, scope.sendCount, scope.runCount, scope.skipCount, scope.rejectCount }
                    .Any(count => count < 0 || count > 256)) return new string[0];
            if (!seen.Add(scope.scopePath)) return new string[0];
            bool complete = kind == "question"
                ? scope.previousCount == 1 && scope.nextCount == 1 && scope.sendCount == 1
                : scope.runCount == 1 && scope.rejectCount == 1 && scope.skipCount <= 1;
            bool partial = kind == "question"
                ? scope.previousCount > 0 || scope.nextCount > 0
                : scope.runCount > 0 || scope.rejectCount > 0;
            if (completeOnly ? complete : partial) candidates.Add(scope.scopePath);
        }
        return candidates.Where(candidate => !candidates.Any(other =>
                !String.Equals(candidate, other, StringComparison.Ordinal) &&
                other.StartsWith(candidate + "/", StringComparison.Ordinal)))
            .OrderBy(candidate => candidate, StringComparer.Ordinal).ToArray();
    }

    private static PendingScopeEvidence CountPendingScopeSignature(
        string kind, string path, List<PendingNodeName> names)
    {
        PendingScopeEvidence evidence = new PendingScopeEvidence { kind = kind, scopePath = path };
        foreach (PendingNodeName item in names)
        {
            string button = PendingButtonKind(item);
            if (button == "previous") evidence.previousCount++;
            else if (button == "next") evidence.nextCount++;
            else if (button == "send") evidence.sendCount++;
            else if (button == "run") evidence.runCount++;
            else if (button == "skip") evidence.skipCount++;
            else if (button == "reject") evidence.rejectCount++;
        }
        return evidence;
    }

    private static PendingFormEvidence BuildPendingEvidence(
        string kind, Node scope, string regionPath, List<Node> regionNodes, Dictionary<string, int> types,
        bool uniqueScope, bool completeSignature, bool hasUnsupportedDecision)
    {
        List<PendingNodeName> scoped = ScopedPendingNodes(scope, regionNodes, types, true);
        PendingControlDescriptor[] controls;
        string visibleText;
        string commandText;
        bool completeText;
        bool containsCredential;
        bool textTruncated;
        bool hasPassword;
        bool hasUnexpectedEdit;
        bool scopedUnsupported;
        TryBuildPendingControls(scoped, regionPath, kind, out controls, out visibleText, out commandText,
            out completeText, out containsCredential, out hasPassword, out hasUnexpectedEdit, out scopedUnsupported,
            out textTruncated);
        return new PendingFormEvidence {
            kind = kind,
            scopePath = scope.Path,
            regionPath = regionPath,
            visibleText = visibleText,
            commandText = commandText,
            controls = controls,
            uniqueScope = uniqueScope,
            completeSignature = completeSignature,
            completeText = completeText,
            textTruncated = textTruncated,
            containsCredential = containsCredential,
            hasPasswordField = hasPassword,
            hasUnexpectedEdit = hasUnexpectedEdit,
            hasUnsupportedDecision = hasUnsupportedDecision || scopedUnsupported
        };
    }

    private static List<Node> FindScopesWithSignature(
        string kind, List<Node> scopes, List<Node> regionNodes, Dictionary<string, int> types,
        out Dictionary<string, List<PendingNodeName>> namesByScope,
        out PendingScopeEvidence[] scopeEvidence)
    {
        namesByScope = new Dictionary<string, List<PendingNodeName>>(StringComparer.Ordinal);
        List<PendingScopeEvidence> measured = new List<PendingScopeEvidence>();
        foreach (Node scope in scopes)
        {
            if (!HelperBudgetReady()) break;
            List<PendingNodeName> scoped = ScopedPendingNodes(scope, regionNodes, types, false);
            namesByScope[scope.Path] = scoped;
            measured.Add(CountPendingScopeSignature(kind, scope.Path, scoped));
        }
        scopeEvidence = measured.ToArray();
        HashSet<string> selectedPaths = new HashSet<string>(
            SelectClosestPendingScopePaths(scopeEvidence, kind, true), StringComparer.Ordinal);
        return scopes.Where(scope => selectedPaths.Contains(scope.Path)).ToList();
    }

    private static List<PendingFormEvidence> BuildQuestionAndCommandEvidence(
        Node header, string regionPath, List<Node> allNodes, Dictionary<string, int> types)
    {
        List<Node> regionNodes = allNodes.Where(node =>
            String.Equals(node.RegionPath, regionPath, StringComparison.Ordinal)).ToList();
        List<Node> scopes = allNodes.Where(node => {
            int typeId;
            return types.TryGetValue(node.Path, out typeId) && (typeId == 50026 || typeId == 50033) &&
                String.Equals(node.RegionPath, regionPath, StringComparison.Ordinal) &&
                node.Depth > 1 && ScopeBelongsToConversation(header, node, types);
        }).ToList();
        if (scopes.Count > 512 || regionNodes.Count > 5000) return null;

        List<PendingFormEvidence> result = new List<PendingFormEvidence>();
        foreach (string kind in new string[] { "question", "command" })
        {
            Dictionary<string, List<PendingNodeName>> nameCache;
            PendingScopeEvidence[] signatureEvidence;
            List<Node> selected = FindScopesWithSignature(kind, scopes, regionNodes, types,
                out nameCache, out signatureEvidence);
            if (selected.Count > PendingMaxForms) return null;
            bool hasUnsupportedDecision = false;
            foreach (Node scope in selected)
            {
                List<PendingNodeName> names = nameCache.ContainsKey(scope.Path)
                    ? nameCache[scope.Path] : new List<PendingNodeName>();
                hasUnsupportedDecision = names.Any(item => PendingButtonKind(item) == "unsupported-decision");
                result.Add(BuildPendingEvidence(kind, scope, regionPath, regionNodes, types, true, true, hasUnsupportedDecision));
            }
            if (selected.Count == 0)
            {
                // Preserve a bounded desktop-guide descriptor when a specific
                // question or command card is visible but no unique complete
                // Group/Pane scope can be proved.
                HashSet<string> partialPaths = new HashSet<string>(
                    SelectClosestPendingScopePaths(signatureEvidence, kind, false), StringComparer.Ordinal);
                foreach (Node scope in scopes.Where(candidate => partialPaths.Contains(candidate.Path))
                    .Take(PendingMaxForms - result.Count))
                {
                    result.Add(BuildPendingEvidence(kind, scope, regionPath, regionNodes, types,
                        false, false, false));
                }
            }
        }
        return result;
    }

    public static PendingFormsResult InspectPendingForms(Result snapshot, string identityTitle)
    {
        return InspectPendingForms(snapshot, identityTitle, null);
    }

    public static PendingFormsResult InspectPendingForms(Result snapshot, string identityTitle, PendingQuestion[][] metadata)
    {
        if (snapshot == null || snapshot.status == null || snapshot.status.traversalTruncated ||
            !String.IsNullOrEmpty(snapshot.status.errorType) || !String.IsNullOrEmpty(snapshot.status.errorStage) ||
            snapshot.status.traversedNodes < 1 || snapshot.status.traversedNodes > 5000 ||
            snapshot.AllNodeReferences == null || snapshot.AllNodeReferences.Length != snapshot.status.traversedNodes ||
            snapshot.NodeTypeByPath == null || snapshot.NodeTypeByPath.Count != snapshot.AllNodeReferences.Length)
            return PendingFailure(false, false, "snapshot-incomplete");
        if (!HelperBudgetReady()) return PendingFailure(true, false, "reader-budget-expired");
        if (String.IsNullOrWhiteSpace(identityTitle) || identityTitle.Length > 180 ||
            PendingContainsSensitiveText(identityTitle))
            return PendingFailure(true, false, "conversation-identity-unverified");

        ConversationIdentityProof proof = snapshot.identityProof;
        if (proof == null || proof.conversationHeaderMatches != 1 ||
            proof.candidateCount < 1 || proof.candidateCount > 64 ||
            proof.matchedCandidateIndex < 0 || proof.matchedCandidateIndex >= proof.candidateCount)
            return PendingFailure(true, false, "conversation-identity-unverified");

        List<string> sidebarRows;
        if (!TryGetSidebarConversationRowPaths(snapshot, identityTitle, false, out sidebarRows))
            return PendingFailure(true, false, "conversation-identity-unverified");
        List<Node> headerNodes = new List<Node>();
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null || node.Element == null) return PendingFailure(false, false, "snapshot-malformed");
            if (node.Depth <= 0 || sidebarRows.Any(row => IsAtOrBelowConversationRowPath(node.Path, row))) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId) || typeId != 50020) continue;
            bool offscreen;
            if (!ReadKnownBoolean(node, OffscreenPropertyId, out offscreen) || offscreen) continue;
            string name = SafeName(Property(node.Element, NamePropertyId));
            if (String.Equals(name, identityTitle, StringComparison.Ordinal)) headerNodes.Add(node);
        }
        if (headerNodes.Count != 1 || String.IsNullOrEmpty(headerNodes[0].RegionPath) ||
            String.Equals(headerNodes[0].RegionPath, "root", StringComparison.Ordinal))
            return PendingFailure(true, false, "conversation-identity-unverified");
        Node header = headerNodes[0];

        // Re-check only the header's ancestors. A matching sidebar row is not
        // accepted as a conversation header, and unrelated row labels are
        // never read.
        string[] pathParts = header.Path.Split('/');
        string parentPath = String.Empty;
        for (int index = 0; index < pathParts.Length - 1; index++)
        {
            parentPath = index == 0 ? pathParts[index] : parentPath + "/" + pathParts[index];
            int ancestorType;
            if (!snapshot.NodeTypeByPath.TryGetValue(parentPath, out ancestorType) || ancestorType != 50000) continue;
            Node row = snapshot.AllNodeReferences.FirstOrDefault(node =>
                String.Equals(node.Path, parentPath, StringComparison.Ordinal));
            if (row == null || row.Element == null) return PendingFailure(true, false, "conversation-identity-unverified");
            string rowTitle = ConversationRowTitle(SafeName(Property(row.Element, NamePropertyId)));
            if (String.Equals(rowTitle, identityTitle, StringComparison.Ordinal))
                return PendingFailure(true, false, "conversation-identity-unverified");
        }
        if (!HelperBudgetReady()) return PendingFailure(true, false, "reader-budget-expired");

        if (metadata != null && metadata.Length > 0) {
            PendingFormEvidence[] inline = ReadInlineQuestionEvidence(snapshot, header, metadata);
            if (inline.Length == 1) return ProjectPendingFormsEvidence(true, true, inline);
        }

        List<PendingFormEvidence> evidence = BuildQuestionAndCommandEvidence(
            header, header.RegionPath, snapshot.AllNodeReferences.ToList(), snapshot.NodeTypeByPath);
        if (evidence == null || !HelperBudgetReady())
            return PendingFailure(true, true, "reader-budget-expired");
        return ProjectPendingFormsEvidence(true, true, evidence.ToArray());
    }

    // The inline WorkBuddy renderer flattens the question and its bottom
    // answer editor into the conversation's accessibility view. Match the
    // real unresolved local metadata to one current question and a closed
    // set of real controls, rather than treating the whole transcript as a
    // form. No record/call/question IDs are fabricated here.
    private static PendingFormEvidence[] ReadInlineQuestionEvidence(Result snapshot, Node header, PendingQuestion[][] metadata)
    {
        if (metadata.Length > 8) return new PendingFormEvidence[0];
        List<Node> nodes = snapshot.AllNodeReferences.Where(n => n.Depth > 0 && n.RegionPath == header.RegionPath &&
            !BoolProperty(n.Element, OffscreenPropertyId)).ToList();
        Func<Node,int> type = n => snapshot.NodeTypeByPath.ContainsKey(n.Path) ? snapshot.NodeTypeByPath[n.Path] : 0;
        Func<Node,string> name = n => SafeName(Property(n.Element, NamePropertyId));
        List<Node> previous = nodes.Where(n => type(n) == 50000 && (name(n) == "上一题" || name(n) == "Previous question")).ToList();
        List<Node> next = nodes.Where(n => type(n) == 50000 && (name(n) == "下一题" || name(n) == "Next question")).ToList();
        List<Node> send = nodes.Where(n => type(n) == 50000 && (name(n) == "发送" || name(n) == "Send")).ToList();
        List<Node> other = nodes.Where(n => type(n) == 50004 && (name(n) == "其他（输入你的答案）" || name(n) == "Other (type your answer)")).ToList();
        if (previous.Count != 1 || next.Count < 1 || next.Count > 2 || send.Count > 1 || other.Count != 1) return new PendingFormEvidence[0];
        // The pagination Next button is always present. A footer Next exists
        // only for manual/multiple answers; Send exists only on the last page.
        string navigationParent = previous[0].Path.Substring(0, previous[0].Path.LastIndexOf('/'));
        List<Node> navigationNext = next.Where(n => n.Path.Substring(0, n.Path.LastIndexOf('/')) == navigationParent).ToList();
        if (navigationNext.Count != 1) return new PendingFormEvidence[0];
        List<Node> footerNext = next.Where(n => n != navigationNext[0]).ToList();
        List<Node> textNodes = nodes.Where(n => type(n) == 50020).ToList();
        List<string> progress = new List<string>();
        foreach (Node slash in textNodes.Where(n => name(n) == "/")) {
            string parent = slash.Path.Substring(0, slash.Path.LastIndexOf('/'));
            Node left = textNodes.FirstOrDefault(n => n.Index == slash.Index - 1 && n.Path.Substring(0,n.Path.LastIndexOf('/')) == parent);
            Node right = textNodes.FirstOrDefault(n => n.Index == slash.Index + 1 && n.Path.Substring(0,n.Path.LastIndexOf('/')) == parent);
            if (left == null || right == null) continue;
            int index, count;
            if (Int32.TryParse(name(left), out index) && Int32.TryParse(name(right), out count) && index >= 1 && count >= index && count <= 8)
                progress.Add(index.ToString() + "/" + count.ToString());
        }
        progress.AddRange(textNodes.Select(name).Where(n => Regex.IsMatch(n,"^[1-8]/[1-8]$")));
        if (progress.Count != 1) return new PendingFormEvidence[0];
        string[] page = progress[0].Split('/'); int pageIndex = Int32.Parse(page[0]), pageCount = Int32.Parse(page[1]);
        Node advance = pageIndex < pageCount ? (footerNext.Count == 1 ? footerNext[0] : navigationNext[0]) :
            (send.Count == 1 ? send[0] : null);
        if (advance == null) return new PendingFormEvidence[0];
        List<string> selectedCounts = textNodes.Select(name).Where(n => PendingActionSelectedCountPattern.IsMatch(n)).ToList();
        if (selectedCounts.Count > 1) return new PendingFormEvidence[0];
        List<PendingFormEvidence> matches = new List<PendingFormEvidence>();
        foreach (PendingQuestion[] questions in metadata) {
            if (questions == null || questions.Length != pageCount || pageIndex > questions.Length) continue;
            PendingQuestion question = questions[pageIndex - 1]; string validationReason;
            if (!IsSafePendingQuestion(question, out validationReason)) continue;
            List<Node> questionTexts = textNodes.Where(n => name(n) == question.question).ToList();
            if (questionTexts.Count != 1) continue;
            List<Node> selected = new List<Node> { questionTexts[0], previous[0], advance, other[0] };
            List<string> visible = new List<string> { name(questionTexts[0]), progress[0] };
            visible.AddRange(selectedCounts);
            bool complete = true;
            PendingQuestionOption[] options = question.options ?? new PendingQuestionOption[0];
            for (int optionIndex = 0; optionIndex < options.Length; optionIndex++) {
                PendingQuestionOption option = options[optionIndex];
                string shortcut = (optionIndex + 1).ToString() + " " + option.label;
                List<Node> buttons = nodes.Where(n => type(n) == 50000 && (name(n) == option.label || name(n) == shortcut)).ToList();
                // Native choices become disabled while Other contains text.
                // Keep their observed state for binding; only an enabled exact
                // answer target can later receive input.
                if (buttons.Count != 1) { complete = false; break; }
                Node label = textNodes.FirstOrDefault(n => n.Path.StartsWith(buttons[0].Path + "/", StringComparison.Ordinal) && name(n) == option.label);
                if (label == null && name(buttons[0]) != option.label) { complete = false; break; }
                selected.Add(buttons[0]); visible.Add(label == null ? name(buttons[0]) : name(label));
            }
            if (!complete || !HelperBudgetReady()) continue;
            List<PendingControlDescriptor> controls = new List<PendingControlDescriptor>();
            foreach (Node node in selected) {
                bool patternComplete = true;
                List<string> patterns = ReadPendingPatterns(node, ref patternComplete);
                if (!patternComplete || BoolProperty(node.Element, IsPasswordPropertyId)) { complete = false; break; }
                controls.Add(new PendingControlDescriptor { controlType=TypeName(type(node)), accessibleName=type(node)==50020?null:name(node),
                    enabled=BoolProperty(node.Element,EnabledPropertyId), patterns=patterns.ToArray(), pathHash=Hash(node.Path),
                    runtimeIdHash=RuntimeIdHash(node.Element), regionHash=Hash(header.RegionPath), passwordProtected=false });
            }
            if (!complete) continue;
            matches.Add(new PendingFormEvidence { kind="question", scopePath=header.RegionPath, regionPath=header.RegionPath,
                visibleText=String.Join("\n", visible), commandText=String.Empty, controls=controls.ToArray(),
                uniqueScope=true, completeSignature=true, completeText=true });
        }
        return matches.Count == 1 ? matches.ToArray() : new PendingFormEvidence[0];
    }

}
