using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;

public static partial class WorkBuddyWindowsUiaComProbe
{
    private const int PendingActionMaxQuestions = 8;
    private const int PendingActionMaxOptions = 12;
    private const int PendingActionMaxControls = 128;
    private const int PendingActionMaxCommand = 4000;
    private const int PendingActionMaxCustom = 1000;
    private const int PendingActionInspectMs = 1800;
    private const int PendingActionMaxHelperBudgetMs = 15000;

    // Use the remaining time supplied by the wrapper to tighten the existing
    // helper deadline. The stopwatch covers setup and every page/action, so do
    // not restart it here. Only standalone callers without a clock initialize
    // one, bounded by the caller's relative budget.
    private static void ApplyPendingActionBudget(int remainingMilliseconds)
    {
        int requested = Math.Max(0, Math.Min(PendingActionMaxHelperBudgetMs, remainingMilliseconds));
        Stopwatch clock = helperBudgetClock;
        if (clock == null)
        {
            StartHelperBudget(requested);
            return;
        }

        long requestedDeadline = clock.ElapsedMilliseconds + requested;
        int existingDeadline = helperBudgetRemainingMs;
        if (requestedDeadline < existingDeadline)
            helperBudgetRemainingMs = (int)Math.Max(0, requestedDeadline);
    }

    private const int PendingActionInvokePatternId = 10000;
    private const int PendingActionValuePatternId = 10002;
    private const int PendingActionControlTypePropertyId = 30003;
    private const int PendingActionNamePropertyId = 30005;
    private const int PendingActionIsEnabledPropertyId = 30010;
    private const int PendingActionIsPasswordPropertyId = 30019;
    private const int PendingActionIsOffscreenPropertyId = 30022;
    private const int PendingActionValuePropertyId = 30045;

    private static readonly Regex PendingActionHashPattern = new Regex("^[a-f0-9]{16}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex PendingActionSha256Pattern = new Regex("^[a-f0-9]{64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex PendingActionProgressPattern = new Regex("^[1-9][0-9]{0,2}/[1-9][0-9]{0,2}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex PendingActionSelectedCountPattern = new Regex(
        @"^(?:\u5DF2\u9009\u62E9\s*[0-9]{1,3}\s*\u4E2A|[0-9]{1,3}\s+selected)$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly string[] PendingActionNavigationLabels = {
        "Previous question", "Next question", "Send", "\u4E0A\u4E00\u9898", "\u4E0B\u4E00\u9898", "\u53D1\u9001"
    };
    private static readonly string[] PendingActionOtherLabels = {
        "Other (type your answer)", "\u5176\u4ED6\uFF08\u8F93\u5165\u4F60\u7684\u7B54\u6848\uFF09"
    };
    private static readonly string[] PendingActionStopLabels = {
        "Stop Generation", "Stop", "Interrupt", "\u505C\u6B62\u751F\u6210", "\u505C\u6B62", "\u4E2D\u65AD"
    };

    // Request DTOs are intentionally closed and local to this helper. Native
    // function_call IDs and phone aliases never cross this boundary.
    public sealed class PendingActionPlan
    {
        public string kind { get; set; }
        public string expectedExePath { get; set; }
        public PendingFreshFormProof freshFormProof { get; set; }
        public PendingQuestion[] questions { get; set; }
        public PendingQuestionAnswer[] answers { get; set; }
        public PendingControlDescriptor[] controls { get; set; }
        public PendingControlDescriptor targetControl { get; set; }
        public string decision { get; set; }
        public PendingCommandContext context { get; set; }
    }

    public sealed class PendingFreshFormProof
    {
        public object epoch { get; set; }
        public long sequence { get; set; }
        public int expectedCandidateIndex { get; set; }
        public int candidateCount { get; set; }
        public int matchedCandidateIndex { get; set; }
        public int conversationHeaderMatches { get; set; }
        public string historyFingerprint { get; set; }
        public string conversationRegionHash { get; set; }
        public string scopePathHash { get; set; }
        public string[] runtimeIdHashes { get; set; }
        public string formFingerprint { get; set; }
        public int pageIndex { get; set; }
        public int pageCount { get; set; }
        public string questionIndexSource { get; set; }
        public int? selectedCount { get; set; }
        public string selectedCountSource { get; set; }
    }

    public sealed class PendingQuestion
    {
        public string id { get; set; } // Optional source ID; never synthesized or used as a native UIA ID.
        public string question { get; set; }
        public string header { get; set; }
        public string detail { get; set; }
        public PendingQuestionOption[] options { get; set; }
        public bool? multiSelect { get; set; }
        public bool? allowCustom { get; set; }
    }

    public sealed class PendingQuestionOption
    {
        public string label { get; set; }
        public string description { get; set; }
    }

    public sealed class PendingQuestionAnswer
    {
        public int questionIndex { get; set; }
        public string[] selectedLabels { get; set; }
        public string custom { get; set; }
    }

    public sealed class PendingCommandContext
    {
        public string kind { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
    }

    internal sealed class PendingIdentityHeaderCandidate
    {
        public string path { get; set; }
        public string regionPath { get; set; }
        public string accessibleName { get; set; }
        public bool offscreen { get; set; }
    }

    public sealed class PendingActionReceipt
    {
        public bool attempted { get; set; }
        public string stage { get; set; }
        public bool uiSubmitted { get; set; }
        public bool postconditionObserved { get; set; }
        public bool postconditionUnknown { get; set; }
        public bool uiClosed { get; set; }
        public bool idleObserved { get; set; }
        public bool targetContextVerified { get; set; }
        public bool conversationIdentityVerified { get; set; }
        public bool nativeResultConfirmed { get; set; }
        public string reason { get; set; }
        public string selectedCountBaselineSource { get; set; }
        public PendingPatternReceipt[] receipts { get; set; }
    }

    public sealed class PendingPatternReceipt
    {
        public string operation { get; set; }
        public int questionIndex { get; set; }
        public string runtimeIdHash { get; set; }
        public int hresult { get; set; }
        public bool foregroundObserved { get; set; }
        public bool attempted { get; set; }
        public bool submitted { get; set; }
        public string stage { get; set; }
    }

    internal sealed class PendingActionValidation
    {
        internal bool valid;
        internal string reason;
    }

    internal sealed class PendingActionIntent
    {
        internal string operation;
        internal int questionIndex;
        internal string label;
        internal PendingControlDescriptor target;
        internal string payload;
    }

    private sealed class PendingActionState
    {
        internal Result snapshot;
        internal PendingFormsResult forms;
        internal PendingFormDescriptor form;
    }

    private sealed class PendingActionPatternResult
    {
        internal PendingPatternReceipt receipt;
        internal bool foregroundObserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PendingActionTokenUser
    {
        internal IntPtr Sid;
        internal IntPtr Attributes;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass,
        IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

    private static PendingActionReceipt NewPendingActionReceipt(string stage, string reason)
    {
        return new PendingActionReceipt {
            attempted = false,
            stage = stage,
            uiSubmitted = false,
            postconditionObserved = false,
            postconditionUnknown = false,
            uiClosed = false,
            idleObserved = false,
            targetContextVerified = false,
            conversationIdentityVerified = false,
            nativeResultConfirmed = false,
            reason = reason,
            selectedCountBaselineSource = String.Empty,
            receipts = new PendingPatternReceipt[0]
        };
    }

    internal static PendingActionValidation ValidatePendingActionPlan(PendingActionPlan plan,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex)
    {
        PendingActionValidation result = new PendingActionValidation { valid = false, reason = "invalid-plan" };
        if (plan == null || String.IsNullOrWhiteSpace(identityTitle) || identityTitle.Length > 180 ||
            PendingContainsSensitiveText(identityTitle) || identityCandidates == null || identityCandidates.Length < 1 ||
            identityCandidates.Length > 64 || expectedCandidateIndex < 0 || expectedCandidateIndex >= identityCandidates.Length ||
            plan.expectedExePath == null || plan.expectedExePath.Length > 1024 || !IsAbsoluteWindowsPath(plan.expectedExePath)) return result;

        if (plan.kind == "question")
        {
            if (plan.decision != null || plan.context != null || plan.targetControl != null ||
                plan.questions == null || plan.questions.Length < 1 || plan.questions.Length > PendingActionMaxQuestions ||
                plan.answers == null || plan.answers.Length != plan.questions.Length || plan.controls == null ||
                plan.controls.Length < 1 || plan.controls.Length > PendingActionMaxControls || plan.freshFormProof == null)
                return result;
            for (int index = 0; index < plan.questions.Length; index++)
            {
                string reason;
                if (!IsSafePendingQuestion(plan.questions[index], out reason)) { result.reason = reason; return result; }
                PendingQuestionAnswer answer = plan.answers[index];
                if (answer == null || answer.questionIndex != index || answer.selectedLabels == null ||
                    answer.selectedLabels.Length > PendingActionMaxOptions ||
                    (answer.custom != null && answer.selectedLabels.Length > 0) ||
                    (answer.custom != null && !IsSafePendingText(answer.custom, PendingActionMaxCustom)) ||
                    (answer.custom != null && plan.questions[index].allowCustom == false))
                { result.reason = "invalid-question-answer"; return result; }

                HashSet<string> selected = new HashSet<string>(StringComparer.Ordinal);
                foreach (string label in answer.selectedLabels)
                {
                    if (!selected.Add(label) || !QuestionHasOption(plan.questions[index], label))
                    { result.reason = "invalid-question-answer"; return result; }
                }
                if (plan.questions[index].multiSelect != true && answer.selectedLabels.Length > 1)
                { result.reason = "invalid-question-answer"; return result; }
                if (answer.selectedLabels.Length == 0 && answer.custom == null)
                { result.reason = "empty-question-answer"; return result; }
            }
            if (!ValidateFreshProof(plan.freshFormProof, identityCandidates.Length, expectedCandidateIndex, "question"))
            { result.reason = "invalid-fresh-proof"; return result; }
            if (!AreSafeControlDescriptors(plan.controls)) { result.reason = "invalid-form-controls"; return result; }
            result.valid = true;
            result.reason = "valid";
            return result;
        }

        if (plan.kind == "approval")
        {
            if ((plan.decision != "allow-once" && plan.decision != "reject") || plan.questions != null ||
                plan.answers != null || plan.controls != null || plan.targetControl == null || plan.context == null ||
                plan.context.kind != "command" || !IsSafePendingText(plan.context.command, PendingActionMaxCommand) ||
                HasPendingTextTruncationEvidence(plan.context.command, PendingActionMaxCommand) ||
                !IsAbsoluteWindowsPath(plan.context.cwd) || plan.freshFormProof == null ||
                !ValidateFreshProof(plan.freshFormProof, identityCandidates.Length, expectedCandidateIndex, "command") ||
                !IsSafeControlDescriptor(plan.targetControl) || plan.targetControl.controlType != "ControlType.Button" ||
                plan.targetControl.enabled != true || !plan.targetControl.patterns.Contains("invoke"))
                return result;
            if (!PendingCommandDecisionLabel(plan.targetControl.accessibleName, plan.decision)) return result;
            result.valid = true;
            result.reason = "valid";
            return result;
        }

        if (plan.kind == "stop")
        {
            if (plan.questions != null || plan.answers != null || plan.controls != null || plan.context != null ||
                plan.decision != null || plan.targetControl == null || plan.freshFormProof == null ||
                !ValidateFreshProof(plan.freshFormProof, identityCandidates.Length, expectedCandidateIndex, "stop") ||
                !IsSafeControlDescriptor(plan.targetControl) || plan.targetControl.controlType != "ControlType.Button" ||
                !PendingActionStopLabels.Contains(plan.targetControl.accessibleName, StringComparer.Ordinal) ||
                plan.targetControl.enabled != true || !plan.targetControl.patterns.Contains("invoke") ||
                !String.Equals(plan.targetControl.regionHash, plan.freshFormProof.conversationRegionHash, StringComparison.Ordinal))
                return result;
            result.valid = true;
            result.reason = "valid";
        }
        return result;
    }

    private static bool ValidateFreshProof(PendingFreshFormProof proof, int candidateCount, int expectedIndex, string kind)
    {
        if (proof == null || !IsSafeGeneration(proof.epoch) || proof.sequence < 0 ||
            proof.expectedCandidateIndex != expectedIndex ||
            proof.candidateCount != candidateCount || proof.matchedCandidateIndex != expectedIndex ||
            proof.conversationHeaderMatches != 1 || !PendingActionSha256Pattern.IsMatch(proof.historyFingerprint ?? String.Empty) ||
            !PendingActionHashPattern.IsMatch(proof.conversationRegionHash ?? String.Empty) ||
            !PendingActionSha256Pattern.IsMatch(proof.formFingerprint ?? String.Empty) ||
            proof.runtimeIdHashes == null || proof.runtimeIdHashes.Length < 1 || proof.runtimeIdHashes.Length > PendingActionMaxControls ||
            proof.runtimeIdHashes.Any(hash => !PendingActionHashPattern.IsMatch(hash ?? String.Empty)) ||
            proof.runtimeIdHashes.Distinct(StringComparer.Ordinal).Count() != proof.runtimeIdHashes.Length) return false;
        if (kind == "stop")
            return PendingActionHashPattern.IsMatch(proof.scopePathHash ?? String.Empty) &&
                proof.runtimeIdHashes.Length == 1;
        if (!PendingActionHashPattern.IsMatch(proof.scopePathHash ?? String.Empty)) return false;
        if (kind == "command") return proof.pageIndex == 0 && proof.pageCount == 0 &&
            proof.questionIndexSource == null && proof.selectedCount == null && proof.selectedCountSource == null;
        if (kind != "question" || proof.pageIndex < 1 || proof.pageCount < 1 || proof.pageCount > PendingActionMaxQuestions ||
            proof.pageIndex > proof.pageCount || (proof.questionIndexSource != "native-progress" &&
            proof.questionIndexSource != "single-question-derived") ||
            (proof.selectedCountSource != "native-visible-count" && proof.selectedCountSource != "unavailable")) return false;
        if (proof.questionIndexSource == "single-question-derived" && (proof.pageIndex != 1 || proof.pageCount != 1)) return false;
        if (proof.selectedCountSource == "native-visible-count")
            return proof.selectedCount.HasValue && proof.selectedCount.Value >= 0 && proof.selectedCount.Value <= PendingActionMaxOptions;
        return !proof.selectedCount.HasValue;
    }

    private static bool IsSafeGeneration(object generation)
    {
        if (generation == null) return false;
        if (generation is long) return (long)generation >= 0;
        if (generation is int) return (int)generation >= 0;
        string value = generation as string;
        return value != null && value.Length > 0 && value.Length <= 128 && value.Trim() == value && !value.Any(Char.IsControl);
    }

    private static bool IsAbsoluteWindowsPath(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length > 1024 || value.Trim() != value ||
            value.Any(character => Char.IsControl(character) || character == '/') ||
            Regex.IsMatch(value, @"^\\\\[?.]\\", RegexOptions.CultureInvariant)) return false;
        bool drive = Regex.IsMatch(value, @"^[A-Za-z]:\\", RegexOptions.CultureInvariant);
        bool unc = Regex.IsMatch(value, @"^\\\\[^\\/]+\\[^\\/]+(?:\\|$)", RegexOptions.CultureInvariant);
        if (!drive && !unc) return false;
        string[] pieces = value.Replace('/', '\\').Split('\\');
        if (pieces.Any(piece => piece == "." || piece == "..")) return false;
        try
        {
            string canonical = Path.GetFullPath(value);
            return String.Equals(canonical.TrimEnd('\\'), value.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static bool IsSafePendingText(string value, int maxLength)
    {
        if (value == null || value.Length == 0 || value.Length > maxLength || value.Trim() != value ||
            PendingContainsSensitiveText(value) || HasPendingTextTruncationEvidence(value, maxLength)) return false;
        foreach (char character in value)
            if (Char.IsControl(character) && character != '\r' && character != '\n' && character != '\t') return false;
        return true;
    }

    private static bool IsSafePendingQuestion(PendingQuestion question, out string reason)
    {
        reason = "invalid-question";
        if (question == null || !IsSafePendingText(question.question, 1000)) return false;
        if (question.id != null && (question.id.Length == 0 || question.id.Length > 200 || question.id.Any(Char.IsControl))) return false;
        if (question.header != null && (question.header.Length > 200 || (question.header.Length > 0 && !IsSafePendingText(question.header, 200)))) return false;
        if (question.detail != null && (question.detail.Length > 1000 || (question.detail.Length > 0 && !IsSafePendingText(question.detail, 1000)))) return false;
        if (question.options != null)
        {
            if (question.options.Length == 0 || question.options.Length > PendingActionMaxOptions) return false;
            HashSet<string> labels = new HashSet<string>(StringComparer.Ordinal);
            foreach (PendingQuestionOption option in question.options)
            {
                if (option == null || !IsSafePendingText(option.label, 200) || !labels.Add(option.label) ||
                    (option.description != null && (option.description.Length > 500 ||
                    (option.description.Length > 0 && !IsSafePendingText(option.description, 500))))) return false;
            }
        }
        reason = "valid";
        return true;
    }

    private static bool IsSafeControlDescriptor(PendingControlDescriptor control)
    {
        return control != null && control.controlType != null && control.controlType.Length <= 64 &&
            control.accessibleName != null && control.accessibleName.Length > 0 && control.accessibleName.Length <= 256 &&
            !PendingContainsSensitiveText(control.accessibleName) && PendingActionHashPattern.IsMatch(control.pathHash ?? String.Empty) &&
            PendingActionHashPattern.IsMatch(control.runtimeIdHash ?? String.Empty) &&
            PendingActionHashPattern.IsMatch(control.regionHash ?? String.Empty) && control.patterns != null &&
            control.patterns.Length <= 6 && !control.passwordProtected &&
            control.patterns.All(pattern => pattern == "invoke" || pattern == "selectionItem" || pattern == "toggle" ||
                pattern == "value" || pattern == "text" || pattern == "expandCollapse");
    }

    private static bool AreSafeControlDescriptors(PendingControlDescriptor[] controls)
    {
        if (controls == null || controls.Length < 1 || controls.Length > PendingActionMaxControls) return false;
        HashSet<string> runtimeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (PendingControlDescriptor control in controls)
        {
            if (control == null || control.controlType == null || control.controlType.Length > 64 ||
                control.passwordProtected || control.pathHash == null || !PendingActionHashPattern.IsMatch(control.pathHash) ||
                !PendingActionHashPattern.IsMatch(control.regionHash ?? String.Empty) || control.patterns == null || control.patterns.Length > 6)
                return false;
            if (control.accessibleName != null && (control.accessibleName.Length > 256 || PendingContainsSensitiveText(control.accessibleName))) return false;
            foreach (string pattern in control.patterns)
                if (pattern != "invoke" && pattern != "selectionItem" && pattern != "toggle" && pattern != "value" && pattern != "text" && pattern != "expandCollapse") return false;
            bool action = control.controlType == "ControlType.Button" || control.controlType == "ControlType.ListItem" || control.controlType == "ControlType.Edit";
            if (action && (!IsSafeControlDescriptor(control) || !runtimeIds.Add(control.runtimeIdHash))) return false;
        }
        return runtimeIds.Count > 0;
    }

    private static bool PendingCommandDecisionLabel(string name, string decision)
    {
        string[] labels = decision == "allow-once" ? new[] { "Run", "\u8FD0\u884C", "\u57F7\u884C" } :
            decision == "reject" ? new[] { "Reject", "\u62D2\u7EDD", "\u62D2\u7D55" } : new string[0];
        return labels.Contains(name, StringComparer.Ordinal);
    }

    private static bool QuestionHasOption(PendingQuestion question, string label)
    {
        return question != null && question.options != null && question.options.Any(option => option != null &&
            String.Equals(option.label, label, StringComparison.Ordinal));
    }

    private static string NativeQuestionOptionLabel(PendingQuestion question, string name)
    {
        if (question == null || question.options == null) return String.Empty;
        List<string> matches = new List<string>();
        for (int index=0; index<question.options.Length; index++) {
            string label = question.options[index].label;
            if (name == label || name == (index+1).ToString() + " " + label) matches.Add(label);
        }
        return matches.Count == 1 ? matches[0] : String.Empty;
    }

    private static bool IsNavigationLabel(string label)
    {
        return PendingActionNavigationLabels.Any(value => String.Equals(value, label, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsOtherLabel(string label)
    {
        return PendingActionOtherLabels.Any(value => String.Equals(value, label, StringComparison.OrdinalIgnoreCase));
    }

    private static bool HasExactMultiset(IEnumerable<string> expected, IEnumerable<string> observed)
    {
        List<string> left = expected.ToList();
        List<string> right = observed.ToList();
        if (left.Count != right.Count) return false;
        Dictionary<string, int> counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (string value in left)
        {
            if (!counts.ContainsKey(value)) counts[value] = 0;
            counts[value]++;
        }
        foreach (string value in right)
        {
            if (!counts.ContainsKey(value) || counts[value] == 0) return false;
            counts[value]--;
        }
        return counts.Values.All(count => count == 0);
    }

    private static bool ContainsMultiset(IEnumerable<string> needles, IEnumerable<string> haystack)
    {
        Dictionary<string, int> counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (string value in haystack)
        {
            if (!counts.ContainsKey(value)) counts[value] = 0;
            counts[value]++;
        }
        foreach (string value in needles)
        {
            if (!counts.ContainsKey(value) || counts[value] == 0) return false;
            counts[value]--;
        }
        return true;
    }

    private static IEnumerable<string> NormalizeTextLines(string value)
    {
        return (value ?? String.Empty).Replace("\r\n", "\n").Replace('\r', '\n').Split('\n')
            .Select(line => line.Trim()).Where(line => line.Length > 0);
    }

    private static IEnumerable<string> ExpandExpectedLines(string value)
    {
        return NormalizeTextLines(value);
    }

    internal static bool PendingQuestionFormMatches(PendingQuestion question, PendingFormDescriptor form,
        int expectedPageIndex, int expectedPageCount, string expectedQuestionIndexSource)
    {
        if (question == null || form == null || form.kind != "question" || !form.complete || form.desktopGuide ||
            !PendingActionHashPattern.IsMatch(form.conversationRegionHash ?? String.Empty) ||
            !PendingActionHashPattern.IsMatch(form.scopePathHash ?? String.Empty) ||
            String.IsNullOrEmpty(form.visibleText) || PendingContainsSensitiveText(form.visibleText) ||
            HasPendingTextTruncationEvidence(form.visibleText, 8192) || form.controls == null ||
            form.controls.Length < 1 || form.controls.Length > PendingActionMaxControls) return false;

        List<string> visible = NormalizeTextLines(form.visibleText).ToList();
        List<string> progress = visible.Where(line => PendingActionProgressPattern.IsMatch(line)).ToList();
        List<string> selectedCounts = visible.Where(line => PendingActionSelectedCountPattern.IsMatch(line)).ToList();
        if (expectedQuestionIndexSource == "native-progress")
        {
            if (form.questionIndexSource != "native-progress" || form.pageIndex != expectedPageIndex ||
                form.pageCount != expectedPageCount || progress.Count != 1 ||
                progress[0] != expectedPageIndex.ToString() + "/" + expectedPageCount.ToString()) return false;
        }
        else if (expectedQuestionIndexSource == "single-question-derived")
        {
            if (expectedPageIndex != 1 || expectedPageCount != 1 || form.questionIndexSource != "unavailable" ||
                form.pageIndex.HasValue || form.pageCount.HasValue || progress.Count != 0) return false;
        }
        else return false;

        if (form.selectedCountSource == "native-visible-count")
        {
            if (!form.selectedCount.HasValue || form.selectedCount.Value < 0 || form.selectedCount.Value > PendingActionMaxOptions ||
                selectedCounts.Count != 1) return false;
            int parsed;
            Match match = PendingActionSelectedCountPattern.Match(selectedCounts[0]);
            Match digits = Regex.Match(selectedCounts[0], "[0-9]{1,3}", RegexOptions.CultureInvariant);
            if (!match.Success || !digits.Success || !Int32.TryParse(digits.Value, out parsed) || parsed != form.selectedCount.Value) return false;
        }
        else if (form.selectedCountSource == "unavailable")
        {
            if (form.selectedCount.HasValue || selectedCounts.Count > 0) return false;
        }
        else return false;

        HashSet<string> ignorable = new HashSet<string>(PendingActionNavigationLabels, StringComparer.OrdinalIgnoreCase);
        if (expectedQuestionIndexSource == "native-progress") ignorable.Add(expectedPageIndex.ToString() + "/" + expectedPageCount.ToString());
        if (selectedCounts.Count == 1) ignorable.Add(selectedCounts[0]);
        List<string> filtered = visible.Where(line => !ignorable.Contains(line)).ToList();
        List<string> expectedVisible = new List<string>();
        List<string> requiredVisible = new List<string>(ExpandExpectedLines(question.question));
        expectedVisible.AddRange(ExpandExpectedLines(question.question));
        if (!String.IsNullOrEmpty(question.header)) expectedVisible.AddRange(ExpandExpectedLines(question.header));
        if (!String.IsNullOrEmpty(question.detail)) expectedVisible.AddRange(ExpandExpectedLines(question.detail));
        if (question.options != null)
        {
            foreach (PendingQuestionOption option in question.options)
            {
                requiredVisible.AddRange(ExpandExpectedLines(option.label));
                expectedVisible.AddRange(ExpandExpectedLines(option.label));
                if (!String.IsNullOrEmpty(option.description)) expectedVisible.AddRange(ExpandExpectedLines(option.description));
            }
        }
        if (!ContainsMultiset(requiredVisible, filtered) || !ContainsMultiset(filtered, expectedVisible)) return false;

        List<PendingControlDescriptor> actionable = form.controls.Where(control => control != null &&
            (control.controlType == "ControlType.Button" || control.controlType == "ControlType.ListItem")).ToList();
        List<string> optionControls = actionable.Where(control => !IsNavigationLabel(control.accessibleName))
            .Select(control => NativeQuestionOptionLabel(question, control.accessibleName)).ToList();
        List<string> expectedOptions = question.options == null ? new List<string>() : question.options.Select(option => option.label).ToList();
        if (!HasExactMultiset(expectedOptions, optionControls)) return false;

        List<PendingControlDescriptor> edits = form.controls.Where(control => control != null && control.controlType == "ControlType.Edit").ToList();
        if (edits.Count > 1 || edits.Any(edit => !IsOtherLabel(edit.accessibleName) || !edit.enabled || edit.passwordProtected ||
            edit.patterns == null || !edit.patterns.Contains("value"))) return false;
        if (edits.Count == 1 && question.allowCustom == false) return false;
        List<PendingControlDescriptor> advances = actionable.Where(control =>
            String.Equals(control.accessibleName, "Next question", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(control.accessibleName, "Send", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(control.accessibleName, "\u4E0B\u4E00\u9898", StringComparison.Ordinal) ||
            String.Equals(control.accessibleName, "\u53D1\u9001", StringComparison.Ordinal)).ToList();
        if (advances.Count != 1 || advances.Any(control => !control.enabled || control.patterns == null || !control.patterns.Contains("invoke"))) return false;
        return true;
    }

    internal static PendingActionIntent[] ProjectQuestionPageActions(PendingQuestion question,
        PendingQuestionAnswer answer, PendingFormDescriptor form, int pageIndex, int pageCount,
        bool otherEditKnownBlank, out string selectedCountBaselineSource)
    {
        selectedCountBaselineSource = String.Empty;
        if (question == null || answer == null || answer.questionIndex != pageIndex - 1 ||
            answer.selectedLabels == null || !PendingQuestionFormMatches(question, form, pageIndex, pageCount,
                pageCount == 1 && form != null && form.questionIndexSource == "unavailable"
                    ? "single-question-derived" : "native-progress")) return new PendingActionIntent[0];
        List<PendingActionIntent> actions = new List<PendingActionIntent>();
        PendingControlDescriptor other = form.controls.SingleOrDefault(control => control != null &&
            control.controlType == "ControlType.Edit" && IsOtherLabel(control.accessibleName));
        if (answer.custom != null)
        {
            if (answer.selectedLabels.Length != 0 || (question.allowCustom == false) || other == null || !otherEditKnownBlank ||
                !IsSafePendingText(answer.custom, PendingActionMaxCustom)) return new PendingActionIntent[0];
            actions.Add(new PendingActionIntent { operation = "set-other-value", questionIndex = pageIndex - 1,
                label = other.accessibleName, target = other, payload = answer.custom });
            PendingControlDescriptor advance = FindQuestionAdvance(form, pageIndex, pageCount);
            if (advance == null) return new PendingActionIntent[0];
            actions.Add(new PendingActionIntent { operation = pageIndex < pageCount ? "invoke-next" : "invoke-send",
                questionIndex = pageIndex - 1, label = advance.accessibleName, target = advance });
            return actions.ToArray();
        }

        bool multiSelect = question.multiSelect == true;
        if (multiSelect)
        {
            if (form.selectedCountSource == "native-visible-count" && form.selectedCount == 0)
                selectedCountBaselineSource = "native-visible-count";
            else if (form.selectedCountSource == "unavailable" && !form.selectedCount.HasValue && other != null && otherEditKnownBlank)
                selectedCountBaselineSource = "renderer-empty-omission-derived";
            else return new PendingActionIntent[0];
            if (answer.selectedLabels.Length == 0 || answer.selectedLabels.Length > PendingActionMaxOptions)
                return new PendingActionIntent[0];
        }
        else if (answer.selectedLabels.Length != 1) return new PendingActionIntent[0];

        foreach (string label in answer.selectedLabels)
        {
            List<PendingControlDescriptor> matches = form.controls.Where(control => control != null &&
                (control.controlType == "ControlType.Button" || control.controlType == "ControlType.ListItem") &&
                !IsNavigationLabel(control.accessibleName) && String.Equals(NativeQuestionOptionLabel(question, control.accessibleName), label, StringComparison.Ordinal) &&
                control.enabled && control.patterns != null && control.patterns.Contains("invoke")).ToList();
            if (matches.Count != 1) return new PendingActionIntent[0];
            actions.Add(new PendingActionIntent { operation = "invoke-option", questionIndex = pageIndex - 1,
                label = label, target = matches[0] });
        }
        if (multiSelect)
        {
            PendingControlDescriptor advance = FindQuestionAdvance(form, pageIndex, pageCount);
            if (advance == null) return new PendingActionIntent[0];
            actions.Add(new PendingActionIntent { operation = pageIndex < pageCount ? "invoke-next" : "invoke-send",
                questionIndex = pageIndex - 1, label = advance.accessibleName, target = advance });
        }
        return actions.ToArray();
    }

    private static PendingControlDescriptor FindQuestionAdvance(PendingFormDescriptor form, int pageIndex, int pageCount)
    {
        string expected = pageIndex < pageCount ? "Next question" : "Send";
        string expectedZh = pageIndex < pageCount ? "\u4E0B\u4E00\u9898" : "\u53D1\u9001";
        List<PendingControlDescriptor> matches = form.controls.Where(control => control != null &&
            control.controlType == "ControlType.Button" &&
            (String.Equals(control.accessibleName, expected, StringComparison.OrdinalIgnoreCase) ||
             String.Equals(control.accessibleName, expectedZh, StringComparison.Ordinal)) && control.enabled &&
            control.patterns != null && control.patterns.Contains("invoke")).ToList();
        return matches.Count == 1 ? matches[0] : null;
    }

    private static bool IsSameControl(PendingControlDescriptor expected, PendingControlDescriptor actual)
    {
        return expected != null && actual != null && expected.controlType == actual.controlType &&
            String.Equals(expected.accessibleName, actual.accessibleName, StringComparison.Ordinal) &&
            expected.enabled == actual.enabled && expected.passwordProtected == actual.passwordProtected &&
            expected.pathHash == actual.pathHash && expected.runtimeIdHash == actual.runtimeIdHash &&
            expected.regionHash == actual.regionHash && expected.patterns != null && actual.patterns != null &&
            expected.patterns.SequenceEqual(actual.patterns, StringComparer.Ordinal);
    }

    private static bool SameQuestionControls(PendingFormDescriptor expected, PendingFormDescriptor actual)
    {
        return expected != null && actual != null && expected.controls != null && actual.controls != null &&
            expected.controls.Length == actual.controls.Length &&
            expected.controls.Zip(actual.controls, (left, right) => left != null && right != null &&
                left.controlType == right.controlType && left.accessibleName == right.accessibleName &&
                left.passwordProtected == right.passwordProtected && left.pathHash == right.pathHash &&
                left.runtimeIdHash == right.runtimeIdHash && left.regionHash == right.regionHash &&
                left.patterns != null && right.patterns != null &&
                left.patterns.SequenceEqual(right.patterns, StringComparer.Ordinal)).All(matches => matches);
    }

    internal static bool MatchesInitialQuestionProof(PendingActionPlan plan, PendingFormDescriptor form)
    {
        PendingFreshFormProof proof = plan.freshFormProof;
        if (form == null || proof == null || form.conversationRegionHash != proof.conversationRegionHash ||
            form.scopePathHash != proof.scopePathHash || plan.controls == null || form.controls == null ||
            plan.controls.Length != form.controls.Length) return false;
        for (int index = 0; index < plan.controls.Length; index++)
            if (!IsSameControl(plan.controls[index], form.controls[index])) return false;
        string[] runtimeIds = form.controls.Where(IsActionControl).Select(control => control.runtimeIdHash).ToArray();
        return proof.runtimeIdHashes != null && proof.runtimeIdHashes.SequenceEqual(runtimeIds, StringComparer.Ordinal);
    }

    private static bool IsActionControl(PendingControlDescriptor control)
    {
        return control != null && (control.controlType == "ControlType.Button" ||
            control.controlType == "ControlType.ListItem" || control.controlType == "ControlType.Edit");
    }

    private static bool IsControlInForm(PendingFormDescriptor form, PendingControlDescriptor target)
    {
        if (form == null || target == null || form.controls == null ||
            target.regionHash != form.conversationRegionHash) return false;
        return form.controls.Count(control => IsSameControl(target, control)) == 1;
    }

    private static bool IsTargetSameUserAndSession(int expectedProcessId)
    {
        IntPtr processHandle = IntPtr.Zero;
        IntPtr tokenHandle = IntPtr.Zero;
        IntPtr tokenBuffer = IntPtr.Zero;
        try
        {
            Process process = Process.GetProcessById(expectedProcessId);
            if (process.HasExited || process.SessionId != Process.GetCurrentProcess().SessionId) return false;
            processHandle = OpenProcess(0x1000, false, expectedProcessId);
            if (processHandle == IntPtr.Zero || !OpenProcessToken(processHandle, 0x0008, out tokenHandle) || tokenHandle == IntPtr.Zero)
                return false;
            int required;
            GetTokenInformation(tokenHandle, 1, IntPtr.Zero, 0, out required);
            if (required < Marshal.SizeOf(typeof(PendingActionTokenUser)) || required > 65536) return false;
            tokenBuffer = Marshal.AllocHGlobal(required);
            if (!GetTokenInformation(tokenHandle, 1, tokenBuffer, required, out required)) return false;
            PendingActionTokenUser tokenUser = (PendingActionTokenUser)Marshal.PtrToStructure(tokenBuffer, typeof(PendingActionTokenUser));
            if (tokenUser.Sid == IntPtr.Zero) return false;
            string processSid = new SecurityIdentifier(tokenUser.Sid).Value;
            using (WindowsIdentity current = WindowsIdentity.GetCurrent())
                return current.User != null && String.Equals(current.User.Value, processSid, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
        finally
        {
            if (tokenBuffer != IntPtr.Zero) Marshal.FreeHGlobal(tokenBuffer);
            if (tokenHandle != IntPtr.Zero) CloseHandle(tokenHandle);
            if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
        }
    }

    private static bool IsExactPendingTarget(IntPtr hwnd, int expectedProcessId, string expectedExePath)
    {
        if (hwnd == IntPtr.Zero || expectedProcessId < 1 || !NativeActionTargetReady(hwnd, expectedProcessId) ||
            !IsTargetSameUserAndSession(expectedProcessId)) return false;
        try
        {
            using (Process process = Process.GetProcessById(expectedProcessId))
            {
                if (process.HasExited || process.MainModule == null) return false;
                string actual = Path.GetFullPath(process.MainModule.FileName);
                string expected = Path.GetFullPath(expectedExePath);
                return String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
            }
        }
        catch { return false; }
    }

    internal static bool IsFreshStatusComplete(Status status, int expectedNodeCount)
    {
        return status != null && !status.traversalTruncated &&
            status.traversedNodes >= 1 && status.traversedNodes <= 5000 &&
            status.traversedNodes == expectedNodeCount &&
            String.IsNullOrEmpty(status.errorType) && String.IsNullOrEmpty(status.errorStage);
    }

    private static bool IsFreshIdentitySnapshot(Result snapshot, int candidateCount, int expectedCandidateIndex)
    {
        if (snapshot == null || snapshot.status == null || !IsFreshStatusComplete(snapshot.status,
            snapshot.AllNodeReferences == null ? 0 : snapshot.AllNodeReferences.Length) ||
            snapshot.AllNodeReferences == null || snapshot.AllNodeReferences.Length != snapshot.status.traversedNodes ||
            snapshot.NodeTypeByPath == null || snapshot.NodeTypeByPath.Count != snapshot.AllNodeReferences.Length ||
            snapshot.controls == null || snapshot.NodeReferences == null || snapshot.controls.Length != snapshot.NodeReferences.Length)
            return false;
        ConversationIdentityProof proof = snapshot.identityProof;
        return proof != null && proof.conversationHeaderMatches == 1 && proof.candidateCount == candidateCount &&
            proof.matchedCandidateIndex == expectedCandidateIndex;
    }

    private static bool ReadFreshQuestionState(IntPtr hwnd, int expectedProcessId, PendingActionPlan plan,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex, int questionIndex,
        bool checkInitialProof, out PendingActionState state, out string reason)
    {
        state = null;
        reason = "fresh-observation-failed";
        if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
        { reason = "target-context"; return false; }
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, PendingActionInspectMs, identityTitle, identityCandidates);
        if (!HelperBudgetReady() || !IsFreshIdentitySnapshot(snapshot, identityCandidates.Length, expectedCandidateIndex))
        { reason = "conversation-identity"; return false; }
        PendingFormsResult forms = InspectPendingForms(snapshot, identityTitle, new[] { plan.questions });
        if (!HelperBudgetReady() || forms == null || !forms.snapshotComplete || !forms.conversationIdentityVerified || forms.forms == null)
        { reason = "pending-form-incomplete"; return false; }
        if (forms.forms.Any(item => item == null || !item.complete || item.desktopGuide))
        { reason = "pending-form-incomplete"; return false; }
        List<PendingFormDescriptor> questions = forms.forms.Where(item => item.kind == "question").ToList();
        if (questions.Count != 1)
        { reason = "question-form-not-unique"; return false; }
        PendingFormDescriptor currentForm = questions[0];
        string expectedQuestionIndexSource = plan.questions.Length == 1
            ? plan.freshFormProof.questionIndexSource : "native-progress";
        if (!PendingQuestionFormMatches(plan.questions[questionIndex], currentForm, questionIndex + 1, plan.questions.Length,
            expectedQuestionIndexSource))
        { reason = "question-context-mismatch"; return false; }
        if (currentForm.conversationRegionHash != plan.freshFormProof.conversationRegionHash)
        { reason = "conversation-region-changed"; return false; }
        if (checkInitialProof && !MatchesInitialQuestionProof(plan, currentForm))
        { reason = "fresh-form-proof-mismatch"; return false; }
        state = new PendingActionState { snapshot = snapshot, forms = forms, form = currentForm };
        reason = "ok";
        return true;
    }

    private static bool ReadFreshCommandState(IntPtr hwnd, int expectedProcessId, PendingActionPlan plan,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex,
        out PendingActionState state, out string reason)
    {
        state = null;
        reason = "fresh-observation-failed";
        if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
        { reason = "target-context"; return false; }
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, PendingActionInspectMs, identityTitle, identityCandidates);
        if (!HelperBudgetReady() || !IsFreshIdentitySnapshot(snapshot, identityCandidates.Length, expectedCandidateIndex))
        { reason = "conversation-identity"; return false; }
        PendingFormsResult forms = InspectPendingForms(snapshot, identityTitle);
        if (!HelperBudgetReady() || forms == null || !forms.snapshotComplete || !forms.conversationIdentityVerified || forms.forms == null)
        { reason = "pending-form-incomplete"; return false; }
        if (forms.forms.Any(form => form == null || !form.complete || form.desktopGuide))
        { reason = "pending-form-incomplete"; return false; }
        List<PendingFormDescriptor> commands = forms.forms.Where(form => form.kind == "command").ToList();
        if (commands.Count != 1) { reason = "command-context-mismatch"; return false; }
        if (!PendingCommandFormMatches(plan, commands[0]))
        { reason = "command-form-mismatch"; return false; }
        state = new PendingActionState { snapshot = snapshot, forms = forms, form = commands[0] };
        reason = "ok";
        return true;
    }

    internal static bool PendingCommandFormMatches(PendingActionPlan plan, PendingFormDescriptor form)
    {
        if (plan == null || plan.kind != "approval" || form == null || !form.complete || form.desktopGuide ||
            form.kind != "command" || plan.context == null || plan.freshFormProof == null || form.controls == null ||
            form.controls.Any(control => control == null) || !IsSafePendingText(form.commandText, PendingActionMaxCommand) ||
            form.commandText != plan.context.command || form.conversationRegionHash != plan.freshFormProof.conversationRegionHash ||
            form.scopePathHash != plan.freshFormProof.scopePathHash) return false;
        List<string> runtimeIds = form.controls.Where(IsActionControl).Select(control => control.runtimeIdHash).ToList();
        if (!plan.freshFormProof.runtimeIdHashes.SequenceEqual(runtimeIds, StringComparer.Ordinal) ||
            !IsControlInForm(form, plan.targetControl)) return false;
        return PendingCommandDecisionLabel(plan.targetControl.accessibleName, plan.decision) &&
            form.controls.Count(control => control.controlType == "ControlType.Button" && PendingCommandDecisionLabel(control.accessibleName, "allow-once")) == 1 &&
            form.controls.Count(control => control.controlType == "ControlType.Button" && PendingCommandDecisionLabel(control.accessibleName, "reject")) == 1;
    }

    private static Node FindExactControlNode(Result snapshot, PendingFormDescriptor form,
        PendingControlDescriptor control, out string reason)
    {
        reason = "target-control-missing";
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null || form == null || control == null)
            return null;
        List<Node> matches = new List<Node>();
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null) { reason = "snapshot-malformed"; return null; }
            if (node.Depth <= 0) continue; // InspectInternal releases the root RCW before returning.
            if (!PendingActionHashPattern.IsMatch(Hash(node.Path)) || Hash(node.Path) != control.pathHash ||
                Hash(String.IsNullOrEmpty(node.RegionPath) ? "root" : node.RegionPath) != control.regionHash) continue;
            string runtimeId = RuntimeIdHash(node.Element);
            if (runtimeId != control.runtimeIdHash) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId) || TypeName(typeId) != control.controlType) continue;
            matches.Add(node);
        }
        if (matches.Count != 1) { reason = "target-control-not-unique"; return null; }
        Node match = matches[0];
        bool enabled = BoolProperty(match.Element, PendingActionIsEnabledPropertyId);
        bool offscreen = BoolProperty(match.Element, PendingActionIsOffscreenPropertyId);
        bool password = BoolProperty(match.Element, PendingActionIsPasswordPropertyId);
        string name = SafeName(Property(match.Element, PendingActionNamePropertyId));
        if (!enabled || offscreen || password || name != control.accessibleName || form.conversationRegionHash != control.regionHash)
        { reason = "target-control-state"; return null; }
        reason = "ok";
        return match;
    }

    private static PendingActionPatternResult InvokePendingControl(IntPtr hwnd, int expectedProcessId,
        PendingActionPlan plan, PendingActionState state, PendingControlDescriptor target,
        string operation, int questionIndex)
    {
        PendingActionPatternResult result = new PendingActionPatternResult {
            receipt = new PendingPatternReceipt { operation = operation, questionIndex = questionIndex,
                runtimeIdHash = target == null ? String.Empty : target.runtimeIdHash,
                hresult = unchecked((int)0x80004005), attempted = false, submitted = false, stage = "target-validate" }
        };
        string reason;
        if (!IsControlInForm(state == null ? null : state.form, target) || !HelperBudgetReady() ||
            !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
        { result.receipt.stage = "target-context"; return result; }
        result.foregroundObserved = IsTargetForeground(hwnd);
        result.receipt.foregroundObserved = result.foregroundObserved;
        Node node = FindExactControlNode(state.snapshot, state.form, target, out reason);
        if (node == null) { result.receipt.stage = reason; return result; }
        object rawPattern = null;
        try
        {
            int patternId = operation == "set-other-value" ? PendingActionValuePatternId : PendingActionInvokePatternId;
            int hr = node.Element.GetCurrentPattern(patternId, out rawPattern);
            if (hr < 0 || rawPattern == null) { result.receipt.hresult = hr; result.receipt.stage = "pattern-unavailable"; return result; }
            if (operation == "set-other-value")
            {
                WorkBuddyIUIAutomationValuePattern valuePattern = rawPattern as WorkBuddyIUIAutomationValuePattern;
                if (valuePattern == null) { result.receipt.hresult = unchecked((int)0x80004002); result.receipt.stage = "value-pattern-type"; return result; }
                bool readOnly;
                string current;
                string customAnswer = FindCustomAnswer(plan, questionIndex);
                if (valuePattern.get_CurrentIsReadOnly(out readOnly) < 0 || readOnly ||
                    valuePattern.get_CurrentValue(out current) < 0 || current == null || (current.Length != 0 && current != customAnswer))
                { result.receipt.hresult = unchecked((int)0x80070490); result.receipt.stage = "other-edit-not-empty"; return result; }
                if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
                { result.receipt.stage = "target-context"; return result; }
                // Foreground is observed for audit only; native UIA is permitted
                // on the exact unlocked default-desktop target when backgrounded.
                result.foregroundObserved = IsTargetForeground(hwnd);
                result.receipt.foregroundObserved = result.foregroundObserved;
                bool typed;
                result.receipt.hresult = TypeNativeOtherAnswer(hwnd, expectedProcessId, plan.expectedExePath, node, customAnswer, current, out typed);
                result.receipt.attempted = typed;
            }
            else
            {
                WorkBuddyIUIAutomationInvokePattern invokePattern = rawPattern as WorkBuddyIUIAutomationInvokePattern;
                if (invokePattern == null) { result.receipt.hresult = unchecked((int)0x80004002); result.receipt.stage = "invoke-pattern-type"; return result; }
                if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
                { result.receipt.stage = "target-context"; return result; }
                result.foregroundObserved = IsTargetForeground(hwnd);
                result.receipt.foregroundObserved = result.foregroundObserved;
                result.receipt.attempted = true;
                result.receipt.hresult = invokePattern.Invoke();
            }
            result.receipt.submitted = result.receipt.hresult >= 0;
            result.receipt.stage = result.receipt.submitted ? "pattern-submitted" : "pattern-call-failed";
            return result;
        }
        catch
        {
            result.receipt.hresult = unchecked((int)0x80004005);
            result.receipt.stage = result.receipt.attempted ? "pattern-call-unknown" : "pattern-call-failed";
            return result;
        }
        finally
        {
            if (rawPattern != null && Marshal.IsComObject(rawPattern))
            {
                try { Marshal.ReleaseComObject(rawPattern); } catch { }
            }
        }
    }

    private static string FindCustomAnswer(PendingActionPlan plan, int questionIndex)
    {
        if (plan == null || plan.answers == null || questionIndex < 0 || questionIndex >= plan.answers.Length) return String.Empty;
        return plan.answers[questionIndex].custom ?? String.Empty;
    }

    private static bool ReadOtherValue(PendingActionState state, out bool blank, out string value)
    {
        blank = false;
        value = null;
        if (state == null || state.form == null) return false;
        List<PendingControlDescriptor> edits = state.form.controls.Where(control => control != null && control.controlType == "ControlType.Edit").ToList();
        if (edits.Count == 0) { blank = true; return true; }
        if (edits.Count != 1 || !IsOtherLabel(edits[0].accessibleName)) return false;
        string reason;
        Node node = FindExactControlNode(state.snapshot, state.form, edits[0], out reason);
        if (node == null) return false;
        object rawPattern = null;
        try
        {
            int hr = node.Element.GetCurrentPattern(PendingActionValuePatternId, out rawPattern);
            WorkBuddyIUIAutomationValuePattern pattern = rawPattern as WorkBuddyIUIAutomationValuePattern;
            bool readOnly;
            if (hr < 0 || pattern == null || pattern.get_CurrentIsReadOnly(out readOnly) < 0 || readOnly ||
                pattern.get_CurrentValue(out value) < 0 || value == null) return false;
            blank = value.Length == 0;
            return true;
        }
        catch { value = null; return false; }
        finally { if (rawPattern != null && Marshal.IsComObject(rawPattern)) { try { Marshal.ReleaseComObject(rawPattern); } catch { } } }
    }

    internal static bool IsMultiSelectCountObserved(PendingFormDescriptor form, int questionIndex,
        int totalQuestions, int selectedCountExpected)
    {
        if (form == null || !form.complete || form.desktopGuide || form.kind != "question") return false;
        bool singletonDerived = totalQuestions == 1 && form.questionIndexSource == "unavailable" &&
            !form.pageIndex.HasValue && !form.pageCount.HasValue;
        if ((!singletonDerived && (form.pageIndex != questionIndex + 1 || form.pageCount != totalQuestions ||
            form.questionIndexSource != "native-progress")) || form.selectedCountSource != "native-visible-count" ||
            form.selectedCount != selectedCountExpected) return false;
        return true;
    }

    private static bool IsExpectedQuestionPage(PendingFormDescriptor form, int pageIndex,
        int pageCount, string source)
    {
        if (form == null || !form.complete || form.desktopGuide || form.kind != "question") return false;
        if (source == "native-progress")
            return form.questionIndexSource == "native-progress" && form.pageIndex == pageIndex && form.pageCount == pageCount;
        return source == "single-question-derived" && pageIndex == 1 && pageCount == 1 &&
            form.questionIndexSource == "unavailable" && !form.pageIndex.HasValue && !form.pageCount.HasValue;
    }

    private static bool FreshQuestionPostcondition(PendingActionState before, PendingActionState after,
        int questionIndex, int totalQuestions, string actionKind, int selectedCountExpected,
        out bool uiClosed, out bool advanced, out string reason)
    {
        uiClosed = false;
        advanced = false;
        reason = "postcondition-unknown";
        if (after == null || after.forms == null || !after.forms.snapshotComplete || !after.forms.conversationIdentityVerified)
            return false;
        List<PendingFormDescriptor> questions = after.forms.forms.Where(item => item.kind == "question").ToList();
        if (actionKind == "multi-select")
        {
            if (questions.Count != 1) return false;
            PendingFormDescriptor currentForm = questions[0];
            if (!IsMultiSelectCountObserved(currentForm, questionIndex, totalQuestions, selectedCountExpected)) return false;
            advanced = true;
            reason = "selection-count-observed";
            return true;
        }
        if (questionIndex + 1 < totalQuestions)
        {
            if (questions.Count != 1 || questions[0].pageIndex != questionIndex + 2 ||
                questions[0].pageCount != totalQuestions || questions[0].questionIndexSource != "native-progress") return false;
            advanced = true;
            reason = "next-page-observed";
            return true;
        }
        if (questions.Count == 0)
        {
            uiClosed = true;
            reason = "question-form-closed-observed";
            return true;
        }
        return false;
    }

    private static bool ObserveAfterQuestionAction(IntPtr hwnd, int expectedProcessId, PendingActionPlan plan,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex, PendingActionState before,
        int questionIndex, string actionKind, int selectedCountExpected,
        out PendingActionState after, out bool uiClosed, out bool advanced, out string reason)
    {
        after = null;
        uiClosed = false;
        advanced = false;
        reason = "postcondition-unknown";
        if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
        { reason = "target-context"; return false; }
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, PendingActionInspectMs, identityTitle, identityCandidates);
        if (!HelperBudgetReady() || !IsFreshIdentitySnapshot(snapshot, identityCandidates.Length, expectedCandidateIndex))
        { reason = "conversation-identity"; return false; }
        PendingFormsResult forms = InspectPendingForms(snapshot, identityTitle, new[] { plan.questions });
        if (!HelperBudgetReady() || forms == null || !forms.snapshotComplete || !forms.conversationIdentityVerified || forms.forms == null)
        { reason = "pending-form-incomplete"; return false; }
        if (forms.forms.Any(form => form == null || !form.complete || form.desktopGuide))
        { reason = "pending-form-incomplete"; return false; }
        after = new PendingActionState { snapshot = snapshot, forms = forms,
            form = forms.forms.FirstOrDefault(form => form.kind == "question") };
        if (actionKind == "multi-select" && (after.form == null || before == null || before.form == null ||
            after.form.conversationRegionHash != before.form.conversationRegionHash ||
            after.form.scopePathHash != before.form.scopePathHash ||
            !PendingQuestionFormMatches(plan.questions[questionIndex], after.form, questionIndex + 1,
                plan.questions.Length, plan.questions.Length == 1
                    ? plan.freshFormProof.questionIndexSource : "native-progress")))
        { reason = "question-context-mismatch"; return false; }
        return FreshQuestionPostcondition(before, after, questionIndex, plan.questions.Length, actionKind,
            selectedCountExpected, out uiClosed, out advanced, out reason);
    }

    private static bool ReadFreshCommandPostcondition(IntPtr hwnd, int expectedProcessId, PendingActionPlan plan,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex, out bool closed)
    {
        closed = false;
        if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath)) return false;
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, PendingActionInspectMs, identityTitle, identityCandidates);
        if (!HelperBudgetReady() || !IsFreshIdentitySnapshot(snapshot, identityCandidates.Length, expectedCandidateIndex)) return false;
        PendingFormsResult forms = InspectPendingForms(snapshot, identityTitle);
        if (!HelperBudgetReady() || forms == null || !forms.snapshotComplete || !forms.conversationIdentityVerified || forms.forms == null ||
            forms.forms.Any(form => form == null || !form.complete || form.desktopGuide)) return false;
        List<PendingFormDescriptor> commands = forms.forms.Where(form => form.kind == "command").ToList();
        if (commands.Any(form => form.commandText == plan.context.command))
            return false;
        closed = commands.Count == 0;
        return closed;
    }

    public static PendingActionReceipt ExecutePendingAction(IntPtr hwnd, int expectedProcessId,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex,
        int remainingMilliseconds, PendingActionPlan plan)
    {
        ApplyPendingActionBudget(remainingMilliseconds);
        if (!HelperBudgetReady()) return NewPendingActionReceipt("helper-budget", "helper-budget-expired");
        PendingActionValidation validation = ValidatePendingActionPlan(plan, identityTitle, identityCandidates, expectedCandidateIndex);
        if (validation == null || !validation.valid) return NewPendingActionReceipt("validate", validation == null ? "invalid-plan" : validation.reason);
        if (!IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
            return NewPendingActionReceipt("target-context", "target-context-unverified");
        PendingActionReceipt output = NewPendingActionReceipt("fresh-observation", "not-attempted");
        output.targetContextVerified = true;
        List<PendingPatternReceipt> receipts = new List<PendingPatternReceipt>();
        try
        {
            if (plan.kind == "question")
                ExecuteQuestionPlan(hwnd, expectedProcessId, identityTitle, identityCandidates, expectedCandidateIndex, plan, output, receipts);
            else if (plan.kind == "approval")
                ExecuteApprovalPlan(hwnd, expectedProcessId, identityTitle, identityCandidates, expectedCandidateIndex, plan, output, receipts);
            else
                ExecuteStopPlan(hwnd, expectedProcessId, identityTitle, identityCandidates, expectedCandidateIndex, plan, output, receipts);
        }
        catch
        {
            output.stage = output.attempted ? "action-postcondition" : "helper-error";
            output.reason = output.attempted ? "outcome-unknown" : "helper-error";
            output.postconditionUnknown = output.attempted;
        }
        output.receipts = receipts.ToArray();
        return output;
    }

    private static void AddPatternReceipt(PendingActionReceipt output, List<PendingPatternReceipt> receipts,
        PendingActionPatternResult pattern)
    {
        if (pattern == null || pattern.receipt == null) return;
        receipts.Add(pattern.receipt);
        output.attempted = output.attempted || pattern.receipt.attempted;
        if (pattern.receipt.attempted) output.targetContextVerified = true;
        if (!pattern.receipt.submitted)
        {
            output.stage = pattern.receipt.stage;
            output.reason = pattern.receipt.attempted ? "pattern-outcome-unknown" : pattern.receipt.stage;
            output.postconditionUnknown = pattern.receipt.attempted;
        }
    }

    private static void ExecuteQuestionPlan(IntPtr hwnd, int expectedProcessId, string identityTitle,
        string[][] identityCandidates, int expectedCandidateIndex, PendingActionPlan plan,
        PendingActionReceipt output, List<PendingPatternReceipt> receipts)
    {
        PendingActionState state;
        string reason;
        if (!ReadFreshQuestionState(hwnd, expectedProcessId, plan, identityTitle, identityCandidates, expectedCandidateIndex,
            0, true, out state, out reason))
        { output.stage = "fresh-question"; output.reason = reason; return; }
        output.conversationIdentityVerified = true;
        string expectedQuestionIndexSource = plan.questions.Length == 1
            ? plan.freshFormProof.questionIndexSource : "native-progress";

        for (int questionIndex = 0; questionIndex < plan.questions.Length; questionIndex++)
        {
            if (!HelperBudgetReady()) { output.stage = "helper-budget"; output.reason = "helper-budget-expired"; return; }
            if (questionIndex > 0 && (state == null || state.form == null ||
                !IsExpectedQuestionPage(state.form, questionIndex + 1, plan.questions.Length, expectedQuestionIndexSource) ||
                !PendingQuestionFormMatches(plan.questions[questionIndex], state.form, questionIndex + 1,
                    plan.questions.Length, expectedQuestionIndexSource)))
            { output.stage = "question-page"; output.reason = "next-question-mismatch"; output.postconditionUnknown = true; return; }

            bool otherBlank = true;
            string currentOther;
            if (!ReadOtherValue(state, out otherBlank, out currentOther) ||
                (!otherBlank && currentOther != FindCustomAnswer(plan, questionIndex)))
            { output.stage = "other-edit"; output.reason = "other-edit-not-empty-or-unknown"; return; }
            string baseline;
            PendingActionIntent[] intents = ProjectQuestionPageActions(plan.questions[questionIndex], plan.answers[questionIndex],
                state.form, questionIndex + 1, plan.questions.Length, otherBlank || currentOther == FindCustomAnswer(plan, questionIndex), out baseline);
            if (intents.Length == 0)
            { output.stage = "question-answer"; output.reason = "question-answer-not-actionable"; return; }
            if (baseline.Length > 0) output.selectedCountBaselineSource = baseline;

            bool manualAdvance = intents.Any(intent => intent.operation == "invoke-next" || intent.operation == "invoke-send");
            bool custom = intents.Any(intent => intent.operation == "set-other-value");
            bool multiSelect = plan.questions[questionIndex].multiSelect == true;
            bool clickFailed = false;
            for (int intentIndex = 0; intentIndex < intents.Length; intentIndex++)
            {
                PendingActionIntent intent = intents[intentIndex];
                if (intent.operation == "invoke-next" || intent.operation == "invoke-send") continue;
                PendingActionPatternResult pattern = InvokePendingControl(hwnd, expectedProcessId, plan, state,
                    intent.target, intent.operation, questionIndex);
                AddPatternReceipt(output, receipts, pattern);
                if (!pattern.receipt.submitted)
                { clickFailed = true; return; }

                bool selectionAction = intent.operation == "invoke-option" && multiSelect;
                if (intent.operation == "set-other-value")
                {
                    PendingActionState afterValue;
                    string customReason;
                    if (!ReadFreshQuestionState(hwnd, expectedProcessId, plan, identityTitle, identityCandidates,
                        expectedCandidateIndex, questionIndex, false, out afterValue, out customReason) ||
                        afterValue == null || afterValue.form == null || state.form.scopePathHash != afterValue.form.scopePathHash ||
                        state.form.conversationRegionHash != afterValue.form.conversationRegionHash ||
                        !SameQuestionControls(state.form, afterValue.form))
                    {
                        output.stage = "custom-value-postcondition";
                        output.reason = customReason == "ok" ? "question-scope-changed" : customReason;
                        output.postconditionUnknown = true;
                        return;
                    }
                    bool editBlank;
                    string actualCustom;
                    if (!ReadOtherValue(afterValue, out editBlank, out actualCustom) || editBlank ||
                        actualCustom != plan.answers[questionIndex].custom)
                    {
                        output.stage = "custom-value-postcondition";
                        output.reason = "custom-value-not-observed";
                        output.postconditionUnknown = true;
                        return;
                    }
                    PendingActionIntent advanceIntent = intents.SingleOrDefault(candidate =>
                        candidate.operation == "invoke-next" || candidate.operation == "invoke-send");
                    PendingControlDescriptor freshAdvance = FindQuestionAdvance(afterValue.form, questionIndex + 1, plan.questions.Length);
                    if (advanceIntent == null || freshAdvance == null)
                    {
                        output.stage = "question-advance";
                        output.reason = "advance-control-unavailable";
                        output.postconditionUnknown = true;
                        return;
                    }
                    advanceIntent.target = freshAdvance;
                    state = afterValue;
                    output.postconditionObserved = true;
                    output.reason = "custom-value-observed";
                    continue;
                }
                PendingActionState after;
                bool uiClosed;
                bool advanced;
                string postReason;
                if (!ObserveAfterQuestionAction(hwnd, expectedProcessId, plan, identityTitle, identityCandidates,
                    expectedCandidateIndex, state, questionIndex, selectionAction ? "multi-select" : "question-action",
                    selectionAction ? (intentIndex + 1) : 0, out after, out uiClosed, out advanced, out postReason))
                {
                    output.stage = "question-postcondition";
                    output.reason = postReason;
                    output.postconditionUnknown = true;
                    return;
                }
                output.postconditionObserved = true;
                output.reason = postReason;
                if (uiClosed)
                {
                    if (questionIndex != plan.questions.Length - 1 || manualAdvance)
                    { output.stage = "question-closed-early"; output.reason = "unexpected-question-close"; output.postconditionUnknown = true; return; }
                    output.uiClosed = true;
                    output.uiSubmitted = true;
                    output.stage = "submitted";
                    return;
                }
                state = after;
                if (!selectionAction && !manualAdvance)
                {
                    if (!advanced || (questionIndex < plan.questions.Length - 1 &&
                        !IsExpectedQuestionPage(state.form, questionIndex + 2, plan.questions.Length, expectedQuestionIndexSource)))
                    { output.stage = "question-postcondition"; output.reason = "automatic-page-transition-unverified"; output.postconditionUnknown = true; return; }
                    break; // Single-choice handler auto-advances/sends; never click Next/Send too.
                }
                if (selectionAction && !IsExpectedQuestionPage(after.form, questionIndex + 1,
                    plan.questions.Length, expectedQuestionIndexSource))
                { output.stage = "question-postcondition"; output.reason = "multi-select-page-changed"; output.postconditionUnknown = true; return; }
            }
            if (clickFailed) return;

            if (custom)
            {
                bool blank;
                string actualValue;
                if (!ReadOtherValue(state, out blank, out actualValue) || blank || actualValue != plan.answers[questionIndex].custom)
                { output.stage = "custom-value-postcondition"; output.reason = "custom-value-not-observed"; output.postconditionUnknown = true; return; }
                output.postconditionObserved = true;
                output.reason = "custom-value-observed";
            }

            if (manualAdvance)
            {
                PendingActionIntent advanceIntent = intents.LastOrDefault(intent => intent.operation == "invoke-next" || intent.operation == "invoke-send");
                if (advanceIntent == null || state == null || state.form == null)
                { output.stage = "question-advance"; output.reason = "advance-control-unavailable"; return; }
                if (!custom)
                {
                    PendingControlDescriptor freshAdvance = FindQuestionAdvance(state.form, questionIndex + 1, plan.questions.Length);
                    if (freshAdvance == null || freshAdvance.accessibleName != advanceIntent.label)
                    { output.stage = "question-advance"; output.reason = "advance-control-changed"; output.postconditionUnknown = true; return; }
                    advanceIntent.target = freshAdvance;
                }
                PendingActionPatternResult advance = InvokePendingControl(hwnd, expectedProcessId, plan, state,
                    advanceIntent.target, advanceIntent.operation, questionIndex);
                AddPatternReceipt(output, receipts, advance);
                if (!advance.receipt.submitted) return;
                PendingActionState after;
                bool uiClosed;
                bool advanced;
                string postReason;
                if (!ObserveAfterQuestionAction(hwnd, expectedProcessId, plan, identityTitle, identityCandidates,
                    expectedCandidateIndex, state, questionIndex, "question-action", 0,
                    out after, out uiClosed, out advanced, out postReason))
                { output.stage = "question-postcondition"; output.reason = postReason; output.postconditionUnknown = true; return; }
                output.postconditionObserved = true;
                output.reason = postReason;
                if (uiClosed)
                {
                    if (questionIndex != plan.questions.Length - 1)
                    { output.stage = "question-closed-early"; output.reason = "unexpected-question-close"; output.postconditionUnknown = true; return; }
                    output.uiClosed = true;
                    state = after;
                }
                else
                {
                    if (!advanced || (questionIndex < plan.questions.Length - 1 &&
                        !IsExpectedQuestionPage(after.form, questionIndex + 2, plan.questions.Length, expectedQuestionIndexSource)))
                    { output.stage = "question-postcondition"; output.reason = "page-transition-unverified"; output.postconditionUnknown = true; return; }
                    state = after;
                }
            }

            if (questionIndex < plan.questions.Length - 1 && (state == null || state.form == null ||
                state.form.pageIndex != questionIndex + 2))
            { output.stage = "question-page"; output.reason = "next-question-not-current"; output.postconditionUnknown = true; return; }
        }

        if (output.uiClosed)
        { output.uiSubmitted = true; output.stage = "submitted"; }
        else
        { output.stage = "question-postcondition"; output.reason = "final-question-still-open"; output.postconditionUnknown = true; }
    }

    private static void ExecuteApprovalPlan(IntPtr hwnd, int expectedProcessId, string identityTitle,
        string[][] identityCandidates, int expectedCandidateIndex, PendingActionPlan plan,
        PendingActionReceipt output, List<PendingPatternReceipt> receipts)
    {
        PendingActionState state;
        string reason;
        if (!ReadFreshCommandState(hwnd, expectedProcessId, plan, identityTitle, identityCandidates,
            expectedCandidateIndex, out state, out reason))
        { output.stage = "fresh-command"; output.reason = reason; return; }
        output.conversationIdentityVerified = true;
        PendingActionPatternResult pattern = InvokePendingControl(hwnd, expectedProcessId, plan, state,
            plan.targetControl, plan.decision == "allow-once" ? "run-once" : "reject", -1);
        AddPatternReceipt(output, receipts, pattern);
        if (!pattern.receipt.submitted) return;
        bool closed;
        if (ReadFreshCommandPostcondition(hwnd, expectedProcessId, plan, identityTitle, identityCandidates,
            expectedCandidateIndex, out closed) && closed)
        {
            output.postconditionObserved = true;
            output.uiClosed = true;
            output.uiSubmitted = true;
            output.stage = "submitted";
            output.reason = "approval-form-closed-observed";
        }
        else
        {
            output.postconditionUnknown = true;
            output.stage = "approval-postcondition";
            output.reason = "approval-form-outcome-unknown";
        }
    }

    public static ActionResult NavigateUniqueSidebarConversation(IntPtr hwnd, int pid, string exePath,
        string title, string[][] candidates, int candidateIndex)
    {
        ActionResult receipt = new ActionResult { operation = "invoke", stage = "native-row-unavailable" };
        // Same-title chats need the public UUID route. Never choose a row by
        // list order when the local archive reports more than one candidate.
        if (candidates == null || candidates.Length != 1 || candidateIndex != 0 ||
            !HelperBudgetReady() || !IsExactPendingTarget(hwnd, pid, exePath)) return receipt;
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, 1800, title, candidates);
        if (!HasCompleteSnapshotStatus(snapshot) || !snapshot.status.composerBindingSucceeded ||
            snapshot.identityProof == null || snapshot.identityProof.conversationRowMatches != 1) return receipt;
        List<ControlSummary> composers = snapshot.controls.Where(c => c.safeActionLabel == "composer" && !c.offscreen).ToList();
        if (composers.Count != 1 || composers[0].draftState != "empty") return receipt;
        List<Node> rows = snapshot.AllNodeReferences.Where(n => n.Depth > 0 && IsSidebarConversationCard(n) &&
            BoolProperty(n.Element, EnabledPropertyId) && !BoolProperty(n.Element, OffscreenPropertyId) &&
            snapshot.AllNodeReferences.Any(child => child.Depth > n.Depth && child.Path.StartsWith(n.Path + "/", StringComparison.Ordinal) &&
                snapshot.NodeTypeByPath.ContainsKey(child.Path) && snapshot.NodeTypeByPath[child.Path] == 50020 &&
                SafeName(Property(child.Element, NamePropertyId)) == title)).ToList();
        if (rows.Count != 1 || !HasPattern(rows[0].Element, InvokePatternId)) return receipt;
        object pattern = null;
        try {
            int hr = rows[0].Element.GetCurrentPattern(InvokePatternId, out pattern);
            WorkBuddyIUIAutomationInvokePattern invoke = pattern as WorkBuddyIUIAutomationInvokePattern;
            if (hr < 0 || invoke == null || !HelperBudgetReady() || !IsExactPendingTarget(hwnd, pid, exePath)) return receipt;
            receipt.matchingControls = 1; receipt.targetContextVerified = true;
            receipt.attempted = true; receipt.hresult = invoke.Invoke();
            receipt.submitted = receipt.hresult >= 0; receipt.stage = receipt.submitted ? "submitted" : "pattern-outcome-unknown";
            return receipt;
        } catch { receipt.stage = receipt.attempted ? "pattern-outcome-unknown" : "native-row-unavailable"; return receipt; }
        finally { if (pattern != null && Marshal.IsComObject(pattern)) Marshal.ReleaseComObject(pattern); }
    }

    internal static bool IsAtOrBelowConversationRowPath(string candidatePath, string rowPath)
    {
        return !String.IsNullOrEmpty(candidatePath) && !String.IsNullOrEmpty(rowPath) &&
            (String.Equals(candidatePath, rowPath, StringComparison.Ordinal) ||
             candidatePath.StartsWith(rowPath + "/", StringComparison.Ordinal));
    }

    internal static PendingIdentityHeaderCandidate[] SelectPendingIdentityHeaders(
        string identityTitle, PendingIdentityHeaderCandidate[] candidates, string[] sidebarRowPaths)
    {
        if (String.IsNullOrEmpty(identityTitle) || candidates == null || sidebarRowPaths == null)
            return new PendingIdentityHeaderCandidate[0];
        return candidates.Where(candidate => candidate != null && !candidate.offscreen &&
            String.Equals(candidate.accessibleName, identityTitle, StringComparison.Ordinal) &&
            !sidebarRowPaths.Any(rowPath => IsAtOrBelowConversationRowPath(candidate.path, rowPath)) &&
            !String.IsNullOrEmpty(candidate.regionPath) && !String.Equals(candidate.regionPath, "root", StringComparison.Ordinal))
            .ToArray();
    }

    // The bound ControlSummary.regionHash is the composer-group hash, whereas
    // Node.RegionPath is the raw tree's nearest conversation region. Only the
    // latter can be compared to the verified header region.
    internal static bool IsBoundComposerNodeInConversationRegion(
        string conversationRegionPath, string composerNodePath, string composerRawRegionPath)
    {
        return !String.IsNullOrEmpty(conversationRegionPath) && conversationRegionPath != "root" &&
            !String.IsNullOrEmpty(composerNodePath) &&
            String.Equals(composerRawRegionPath, conversationRegionPath, StringComparison.Ordinal) &&
            composerNodePath.StartsWith(conversationRegionPath + "/", StringComparison.Ordinal);
    }

    private static bool TryGetSidebarConversationRowPaths(Result snapshot, string identityTitle,
        bool allRecognizedRows, out List<string> rowPaths)
    {
        rowPaths = new List<string>();
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null) return false;
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null) return false;
            if (node.Depth <= 0) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId)) return false;
            if (typeId != 50000) continue;
            if (IsSidebarConversationCard(node)) { rowPaths.Add(node.Path); continue; }
            string rowTitle = ConversationRowTitle(SafeName(Property(node.Element, NamePropertyId)));
            if (String.IsNullOrEmpty(rowTitle)) continue;
            bool offscreen;
            bool enabled;
            if (!ReadKnownBoolean(node, OffscreenPropertyId, out offscreen) ||
                !ReadKnownBoolean(node, EnabledPropertyId, out enabled)) return false;
            if (offscreen || !enabled) continue;
            if (allRecognizedRows || String.Equals(rowTitle, identityTitle, StringComparison.Ordinal))
                rowPaths.Add(node.Path);
        }
        return true;
    }

    private static bool FindVerifiedHeaderRegion(Result snapshot, string identityTitle,
        out string regionPath, out int headerCount)
    {
        regionPath = String.Empty;
        headerCount = 0;
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null) return false;
        List<string> sidebarRowPaths;
        if (!TryGetSidebarConversationRowPaths(snapshot, identityTitle, false, out sidebarRowPaths)) return false;
        List<PendingIdentityHeaderCandidate> candidates = new List<PendingIdentityHeaderCandidate>();
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null) return false;
            if (node.Depth <= 0) continue; // Never touch the released root RCW.
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId) || typeId != 50020) continue;
            bool offscreen;
            if (!ReadKnownBoolean(node, OffscreenPropertyId, out offscreen) || offscreen) continue;
            candidates.Add(new PendingIdentityHeaderCandidate {
                path = node.Path, regionPath = node.RegionPath,
                accessibleName = SafeName(Property(node.Element, NamePropertyId)), offscreen = false
            });
        }
        PendingIdentityHeaderCandidate[] headers = SelectPendingIdentityHeaders(
            identityTitle, candidates.ToArray(), sidebarRowPaths.ToArray());
        headerCount = headers.Length;
        if (headers.Length == 1) regionPath = headers[0].regionPath;
        return headerCount == 1 && !String.IsNullOrEmpty(regionPath) && regionPath != "root";
    }

    private static bool TryFindStopControls(Result snapshot, string regionPath,
        out List<PendingControlDescriptor> controls)
    {
        controls = new List<PendingControlDescriptor>();
        if (snapshot == null || snapshot.AllNodeReferences == null || snapshot.NodeTypeByPath == null) return false;
        List<string> sidebarRowPaths;
        if (!TryGetSidebarConversationRowPaths(snapshot, null, true, out sidebarRowPaths)) return false;
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (node == null || node.Depth <= 0 || node.RegionPath != regionPath) continue;
            if (sidebarRowPaths.Any(rowPath => IsAtOrBelowConversationRowPath(node.Path, rowPath))) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId) || typeId != 50000) continue;
            bool offscreen;
            bool enabled;
            bool password;
            if (!ReadKnownBoolean(node, OffscreenPropertyId, out offscreen) || offscreen ||
                !ReadKnownBoolean(node, EnabledPropertyId, out enabled) || !enabled ||
                !ReadKnownBoolean(node, IsPasswordPropertyId, out password) || password) continue;
            string name = SafeName(Property(node.Element, NamePropertyId));
            if (!PendingActionStopLabels.Contains(name, StringComparer.Ordinal)) continue;
            if (!HasPattern(node.Element, InvokePatternId)) continue;
            controls.Add(new PendingControlDescriptor {
                controlType = "ControlType.Button", accessibleName = name, enabled = true,
                patterns = new[] { "invoke" }, pathHash = Hash(node.Path),
                runtimeIdHash = RuntimeIdHash(node.Element), regionHash = Hash(regionPath), passwordProtected = false
            });
        }
        return true;
    }

    private static PendingPatternReceipt InvokeStopControl(IntPtr hwnd, int expectedProcessId,
        PendingActionPlan plan, Result snapshot, string regionPath)
    {
        PendingPatternReceipt receipt = new PendingPatternReceipt {
            operation = "stop-once", questionIndex = -1, runtimeIdHash = plan.targetControl.runtimeIdHash,
            hresult = unchecked((int)0x80004005), attempted = false, submitted = false, stage = "stop-target"
        };
        List<PendingControlDescriptor> controls;
        if (!TryFindStopControls(snapshot, regionPath, out controls))
        { receipt.stage = "stop-scope-unverified"; return receipt; }
        if (controls.Count != 1 || !IsSameControl(controls[0], plan.targetControl) ||
            !HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath)) return receipt;
        Node target = FindStopNode(snapshot, controls[0]);
        if (target == null) { receipt.stage = "stop-target-missing"; return receipt; }
        object rawPattern = null;
        try
        {
            int hr = target.Element.GetCurrentPattern(PendingActionInvokePatternId, out rawPattern);
            WorkBuddyIUIAutomationInvokePattern pattern = rawPattern as WorkBuddyIUIAutomationInvokePattern;
            if (hr < 0 || pattern == null) { receipt.hresult = hr; receipt.stage = "stop-pattern-unavailable"; return receipt; }
            if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
            { receipt.stage = "target-context"; return receipt; }
            receipt.foregroundObserved = IsTargetForeground(hwnd);
            receipt.attempted = true;
            receipt.hresult = pattern.Invoke();
            receipt.submitted = receipt.hresult >= 0;
            receipt.stage = receipt.submitted ? "stop-pattern-submitted" : "pattern-call-unknown";
        }
        catch
        {
            receipt.hresult = unchecked((int)0x80004005);
            receipt.stage = receipt.attempted ? "pattern-call-unknown" : "stop-pattern-failed";
        }
        finally { if (rawPattern != null && Marshal.IsComObject(rawPattern)) { try { Marshal.ReleaseComObject(rawPattern); } catch { } } }
        return receipt;
    }

    private static Node FindStopNode(Result snapshot, PendingControlDescriptor control)
    {
        List<Node> matches = snapshot.AllNodeReferences.Where(node => node != null && node.Depth > 0 &&
            Hash(node.Path) == control.pathHash && RuntimeIdHash(node.Element) == control.runtimeIdHash &&
            Hash(node.RegionPath) == control.regionHash).ToList();
        return matches.Count == 1 ? matches[0] : null;
    }

    private static Node FindBoundComposerNode(Result snapshot, ControlSummary composer)
    {
        if (snapshot == null || snapshot.AllNodeReferences == null || composer == null) return null;
        List<Node> matches = snapshot.AllNodeReferences.Where(node => node != null && node.Depth > 0 &&
            Hash(node.Path) == composer.pathHash && RuntimeIdHash(node.Element) == composer.runtimeIdHash).ToList();
        return matches.Count == 1 ? matches[0] : null;
    }

    private static bool ObserveStopIdle(IntPtr hwnd, int expectedProcessId, PendingActionPlan plan,
        string identityTitle, string[][] identityCandidates, int expectedCandidateIndex)
    {
        if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath)) return false;
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, PendingActionInspectMs, identityTitle, identityCandidates);
        if (!HelperBudgetReady() || !IsFreshIdentitySnapshot(snapshot, identityCandidates.Length, expectedCandidateIndex)) return false;
        string regionPath;
        int headerCount;
        if (!FindVerifiedHeaderRegion(snapshot, identityTitle, out regionPath, out headerCount) || headerCount != 1 ||
            Hash(regionPath) != plan.freshFormProof.conversationRegionHash) return false;
        List<PendingControlDescriptor> stop;
        if (!TryFindStopControls(snapshot, regionPath, out stop) || stop.Count != 0 ||
            !snapshot.status.composerBindingSucceeded) return false;
        List<ControlSummary> composers = snapshot.controls.Where(control => control != null && control.safeActionLabel == "composer" &&
            !control.passwordProtected && !control.offscreen).ToList();
        if (composers.Count != 1) return false;
        Node composerNode = FindBoundComposerNode(snapshot, composers[0]);
        return composerNode != null && IsBoundComposerNodeInConversationRegion(
            regionPath, composerNode.Path, composerNode.RegionPath);
    }

    private static void ExecuteStopPlan(IntPtr hwnd, int expectedProcessId, string identityTitle,
        string[][] identityCandidates, int expectedCandidateIndex, PendingActionPlan plan,
        PendingActionReceipt output, List<PendingPatternReceipt> receipts)
    {
        if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, expectedProcessId, plan.expectedExePath))
        { output.stage = "target-context"; output.reason = "target-context-unverified"; return; }
        Result snapshot = InspectSemanticIdentity(hwnd, 5000, PendingActionInspectMs, identityTitle, identityCandidates);
        if (!HelperBudgetReady() || !IsFreshIdentitySnapshot(snapshot, identityCandidates.Length, expectedCandidateIndex))
        { output.stage = "conversation-identity"; output.reason = "conversation-identity-unverified"; return; }
        string regionPath;
        int headerCount;
        if (!FindVerifiedHeaderRegion(snapshot, identityTitle, out regionPath, out headerCount) || headerCount != 1 ||
            Hash(regionPath) != plan.freshFormProof.conversationRegionHash ||
            Hash(regionPath) != plan.targetControl.regionHash)
        { output.stage = "stop-scope"; output.reason = "stop-scope-unverified"; return; }
        List<PendingControlDescriptor> controls;
        if (!TryFindStopControls(snapshot, regionPath, out controls))
        { output.stage = "stop-scope"; output.reason = "stop-scope-unverified"; return; }
        if (controls.Count != 1 || !IsSameControl(controls[0], plan.targetControl) ||
            !plan.freshFormProof.runtimeIdHashes.SequenceEqual(new[] { controls[0].runtimeIdHash }, StringComparer.Ordinal))
        { output.stage = "stop-control"; output.reason = "stop-control-not-unique"; return; }
        output.conversationIdentityVerified = true;
        PendingPatternReceipt receipt = InvokeStopControl(hwnd, expectedProcessId, plan, snapshot, regionPath);
        receipts.Add(receipt);
        output.attempted = receipt.attempted;
        output.targetContextVerified = receipt.attempted;
        if (!receipt.submitted)
        {
            output.stage = receipt.stage;
            output.reason = receipt.attempted ? "stop-outcome-unknown" : receipt.stage;
            output.postconditionUnknown = receipt.attempted;
            return;
        }
        if (ObserveStopIdle(hwnd, expectedProcessId, plan, identityTitle, identityCandidates, expectedCandidateIndex))
        {
            output.uiSubmitted = true;
            output.postconditionObserved = true;
            output.idleObserved = true;
            output.stage = "submitted";
            output.reason = "idle-observed";
        }
        else
        {
            output.postconditionUnknown = true;
            output.stage = "stop-postcondition";
            output.reason = "idle-state-unobserved";
        }
    }

    public sealed class NativeStopState {
        public bool complete { get; set; }
        public bool conversationIdentityVerified { get; set; }
        public string conversationRegionHash { get; set; }
        public PendingControlDescriptor control { get; set; }
        public bool idleObserved { get; set; }
    }

    public static NativeStopState InspectStopState(Result snapshot, string identityTitle, int candidateCount, int expectedIndex)
    {
        NativeStopState state = new NativeStopState();
        if (!IsFreshIdentitySnapshot(snapshot, candidateCount, expectedIndex)) return state;
        string regionPath; int headerCount;
        if (!FindVerifiedHeaderRegion(snapshot, identityTitle, out regionPath, out headerCount) || headerCount != 1) return state;
        List<PendingControlDescriptor> controls;
        if (!TryFindStopControls(snapshot, regionPath, out controls) || controls.Count > 1) return state;
        state.complete = true; state.conversationIdentityVerified = true; state.conversationRegionHash = Hash(regionPath);
        state.control = controls.Count == 1 ? controls[0] : null;
        state.idleObserved = controls.Count == 0 && snapshot.status.composerBindingSucceeded;
        return state;
    }
}
