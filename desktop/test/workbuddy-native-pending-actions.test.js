'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const COM_SOURCE = path.join(ROOT, 'desktop', 'src', 'workbuddy-native', 'windows-uia-com.cs');
const PENDING_SOURCE = path.join(ROOT, 'desktop', 'src', 'workbuddy-native', 'windows-uia-pending.cs');
const MODEL_POPUP_SOURCE = path.join(ROOT, 'desktop', 'src', 'workbuddy-native', 'model-popup.cs');
const ACTIONS_SOURCE = path.join(ROOT, 'desktop', 'src', 'workbuddy-native', 'pending-actions.cs');

const FIXTURE_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Threading;

public static class WorkBuddyPendingActionsFixture
{
    private const string Region = "aaaaaaaaaaaaaaaa";
    private const string Scope = "bbbbbbbbbbbbbbbb";
    private const string HistoryFingerprint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string FormFingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string ExePath = @"C:\Program Files\WorkBuddy\WorkBuddy.exe";
    private const string Title = "Project X";

    private static WorkBuddyWindowsUiaComProbe.PendingControlDescriptor Control(
        string type, string name, string pathHash, string runtimeHash, string[] patterns)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingControlDescriptor {
            controlType = type, accessibleName = name, enabled = true, patterns = patterns,
            pathHash = pathHash, runtimeIdHash = runtimeHash, regionHash = Region, passwordProtected = false
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormDescriptor QuestionForm(
        string progressSource, string countSource, int? count, bool includeOther, string questionText)
    {
        string visible = "";
        if (progressSource == "native-progress") visible += "1/1\n";
        if (countSource == "native-visible-count") visible += count.Value.ToString() + " selected\n";
        visible += questionText + "\nRed\nBlue";
        var controls = new System.Collections.Generic.List<WorkBuddyWindowsUiaComProbe.PendingControlDescriptor> {
            Control("ControlType.Button", "Previous question", "1000000000000001", "2000000000000001", new[] { "invoke" }),
            Control("ControlType.Button", "Send", "1000000000000002", "2000000000000002", new[] { "invoke" }),
            Control("ControlType.Button", "Red", "1000000000000003", "2000000000000003", new[] { "invoke" }),
            Control("ControlType.Button", "Blue", "1000000000000004", "2000000000000004", new[] { "invoke" })
        };
        if (includeOther)
            controls.Add(Control("ControlType.Edit", "Other (type your answer)", "1000000000000005", "2000000000000005", new[] { "value" }));
        return new WorkBuddyWindowsUiaComProbe.PendingFormDescriptor {
            kind = "question", complete = true, desktopGuide = false,
            conversationRegionHash = Region, scopePathHash = Scope, visibleText = visible,
            commandText = "", pageIndex = progressSource == "native-progress" ? (int?)1 : null,
            pageCount = progressSource == "native-progress" ? (int?)1 : null,
            questionIndexSource = progressSource, selectedCount = count, selectedCountSource = countSource,
            controls = controls.ToArray()
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingQuestion Question(bool multi, bool? allowCustom)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingQuestion {
            id = null, question = "Pick a color", options = new[] {
                new WorkBuddyWindowsUiaComProbe.PendingQuestionOption { label = "Red" },
                new WorkBuddyWindowsUiaComProbe.PendingQuestionOption { label = "Blue" }
            }, multiSelect = multi, allowCustom = allowCustom
        };
    }

    private static string[] RuntimeIds(WorkBuddyWindowsUiaComProbe.PendingFormDescriptor form)
    {
        return form.controls.Where(control => control.controlType == "ControlType.Button" ||
            control.controlType == "ControlType.ListItem" || control.controlType == "ControlType.Edit")
            .Select(control => control.runtimeIdHash).ToArray();
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFreshFormProof Proof(
        string kind, string[] runtimeIds, string questionIndexSource, int? selectedCount, string selectedCountSource)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingFreshFormProof {
            epoch = 1, sequence = 8, expectedCandidateIndex = 0,
            candidateCount = 1, matchedCandidateIndex = 0, conversationHeaderMatches = 1,
            historyFingerprint = HistoryFingerprint, conversationRegionHash = Region,
            scopePathHash = Scope, runtimeIdHashes = runtimeIds, formFingerprint = FormFingerprint,
            pageIndex = kind == "question" ? 1 : 0, pageCount = kind == "question" ? 1 : 0,
            questionIndexSource = questionIndexSource, selectedCount = selectedCount,
            selectedCountSource = selectedCountSource
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingActionPlan QuestionPlan(
        WorkBuddyWindowsUiaComProbe.PendingQuestion question,
        WorkBuddyWindowsUiaComProbe.PendingQuestionAnswer answer,
        WorkBuddyWindowsUiaComProbe.PendingFormDescriptor form)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingActionPlan {
            kind = "question", expectedExePath = ExePath, freshFormProof = Proof("question", RuntimeIds(form),
                form.questionIndexSource == "unavailable" ? "single-question-derived" : "native-progress",
                form.selectedCount, form.selectedCountSource),
            questions = new[] { question }, answers = new[] { answer }, controls = form.controls
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormDescriptor CommandForm(string command)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingFormDescriptor {
            kind = "command", complete = true, desktopGuide = false, conversationRegionHash = Region,
            scopePathHash = Scope, visibleText = "bash\n" + command, commandText = command,
            controls = new[] {
                Control("ControlType.Button", "Run", "3000000000000001", "4000000000000001", new[] { "invoke" }),
                Control("ControlType.Button", "Skip", "3000000000000002", "4000000000000002", new[] { "invoke" }),
                Control("ControlType.Button", "Reject", "3000000000000003", "4000000000000003", new[] { "invoke" })
            }
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingActionPlan CommandPlan(
        WorkBuddyWindowsUiaComProbe.PendingFormDescriptor form)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingActionPlan {
            kind = "approval", expectedExePath = ExePath, decision = "allow-once",
            context = new WorkBuddyWindowsUiaComProbe.PendingCommandContext {
                kind = "command", command = form.commandText, cwd = @"C:\repo\app"
            },
            targetControl = form.controls[0], freshFormProof = Proof("command", RuntimeIds(form), null, null, null)
        };
    }

    private static object[] IntentSummary(WorkBuddyWindowsUiaComProbe.PendingActionIntent[] intents)
    {
        return intents.Select(intent => new { operation = intent.operation, label = intent.label }).ToArray();
    }

    private static FieldInfo PrivateStaticField(string name)
    {
        return typeof(WorkBuddyWindowsUiaComProbe).GetField(name, BindingFlags.Static | BindingFlags.NonPublic);
    }

    private static bool HelperBudgetReady()
    {
        MethodInfo method = typeof(WorkBuddyWindowsUiaComProbe).GetMethod("HelperBudgetReady", BindingFlags.Static | BindingFlags.NonPublic);
        return (bool)method.Invoke(null, null);
    }

    private static string Validate(WorkBuddyWindowsUiaComProbe.PendingActionPlan plan,
        string[][] candidates, int expectedIndex)
    {
        var result = WorkBuddyWindowsUiaComProbe.ValidatePendingActionPlan(plan, Title, candidates, expectedIndex);
        return result.valid ? "valid" : result.reason;
    }

    public static object[] Run()
    {
        var singleQuestion = Question(false, null);
        var singleForm = QuestionForm("unavailable", "unavailable", null, true, "Pick a color");
        var singleAnswer = new WorkBuddyWindowsUiaComProbe.PendingQuestionAnswer {
            questionIndex = 0, selectedLabels = new[] { "Red" }
        };
        var singlePlan = QuestionPlan(singleQuestion, singleAnswer, singleForm);
        string singleBaseline;
        var singleIntents = WorkBuddyWindowsUiaComProbe.ProjectQuestionPageActions(singleQuestion, singleAnswer,
            singleForm, 1, 1, true, out singleBaseline);

        var multiQuestion = Question(true, true);
        var multiAnswer = new WorkBuddyWindowsUiaComProbe.PendingQuestionAnswer {
            questionIndex = 0, selectedLabels = new[] { "Red", "Blue" }
        };
        var derivedMultiForm = QuestionForm("unavailable", "unavailable", null, true, "Pick a color");
        string derivedBaseline;
        var derivedMultiIntents = WorkBuddyWindowsUiaComProbe.ProjectQuestionPageActions(multiQuestion, multiAnswer,
            derivedMultiForm, 1, 1, true, out derivedBaseline);
        var nonzeroMultiForm = QuestionForm("unavailable", "native-visible-count", 1, true, "Pick a color");
        string nonzeroBaseline;
        var nonzeroMultiIntents = WorkBuddyWindowsUiaComProbe.ProjectQuestionPageActions(multiQuestion, multiAnswer,
            nonzeroMultiForm, 1, 1, true, out nonzeroBaseline);
        var missingOtherMultiForm = QuestionForm("unavailable", "unavailable", null, false, "Pick a color");
        string missingOtherBaseline;
        var missingOtherMultiIntents = WorkBuddyWindowsUiaComProbe.ProjectQuestionPageActions(multiQuestion, multiAnswer,
            missingOtherMultiForm, 1, 1, true, out missingOtherBaseline);
        var postSelected = QuestionForm("unavailable", "native-visible-count", 2, true, "Pick a color");
        var wrongCount = QuestionForm("unavailable", "native-visible-count", 1, true, "Pick a color");

        var customQuestion = Question(false, true);
        var customAnswer = new WorkBuddyWindowsUiaComProbe.PendingQuestionAnswer {
            questionIndex = 0, selectedLabels = new string[0], custom = "Purple"
        };
        var customForm = QuestionForm("unavailable", "unavailable", null, true, "Pick a color");
        var customPlan = QuestionPlan(customQuestion, customAnswer, customForm);
        string customBaseline;
        var customIntents = WorkBuddyWindowsUiaComProbe.ProjectQuestionPageActions(customQuestion, customAnswer,
            customForm, 1, 1, true, out customBaseline);
        var customForbiddenQuestion = Question(false, false);
        var customForbiddenPlan = QuestionPlan(customForbiddenQuestion, customAnswer,
            QuestionForm("unavailable", "unavailable", null, false, "Pick a color"));
        string forbiddenBaseline;
        var forbiddenIntents = WorkBuddyWindowsUiaComProbe.ProjectQuestionPageActions(customForbiddenQuestion,
            customAnswer, customForbiddenPlan.controls == null ? null : QuestionForm("unavailable", "unavailable", null, false, "Pick a color"),
            1, 1, true, out forbiddenBaseline);

        var command = CommandForm("echo ...");
        var commandPlan = CommandPlan(command);
        var commandMismatch = CommandForm("echo different");
        var relativeCwd = CommandPlan(command);
        relativeCwd.context.cwd = "repo/app";
        var alwaysPlan = CommandPlan(command);
        alwaysPlan.decision = "allow-always";
        var commandTruncation = CommandForm("echo [truncated]");
        var commandTruncationPlan = CommandPlan(commandTruncation);

        var stopControl = Control("ControlType.Button", "Stop Generation", "5000000000000001",
            "6000000000000001", new[] { "invoke" });
        var stopPlan = new WorkBuddyWindowsUiaComProbe.PendingActionPlan {
            kind = "stop", expectedExePath = ExePath, targetControl = stopControl,
            freshFormProof = Proof("stop", new[] { stopControl.runtimeIdHash }, null, null, null)
        };

        // Expire the shared clock before calling the action entry point. A
        // relative 15-second remainder must not replace the expired deadline.
        WorkBuddyWindowsUiaComProbe.StartHelperBudget(1);
        Stopwatch originalBudgetClock = (Stopwatch)PrivateStaticField("helperBudgetClock").GetValue(null);
        Thread.Sleep(25);
        WorkBuddyWindowsUiaComProbe.PendingActionReceipt expiredBudgetReceipt =
            WorkBuddyWindowsUiaComProbe.ExecutePendingAction(IntPtr.Zero, 0, Title,
                new[] { new[] { "Project X" } }, 0, 15000,
                QuestionPlan(singleQuestion, singleAnswer, singleForm));
        Stopwatch finalBudgetClock = (Stopwatch)PrivateStaticField("helperBudgetClock").GetValue(null);
        bool expiredBudgetRemainsExpired = !HelperBudgetReady();

        var validStatus = new WorkBuddyWindowsUiaComProbe.Status {
            traversedNodes = 2, traversalTruncated = false, errorType = null, errorStage = String.Empty
        };
        var exceptionStatus = new WorkBuddyWindowsUiaComProbe.Status {
            traversedNodes = 2, traversalTruncated = false, errorType = "COMException", errorStage = String.Empty
        };
        var earlyReturnStatus = new WorkBuddyWindowsUiaComProbe.Status {
            traversedNodes = 2, traversalTruncated = false, errorType = null, errorStage = "raw-view-walker"
        };

        var duplicateCandidatePlan = QuestionPlan(singleQuestion, singleAnswer, singleForm);
        duplicateCandidatePlan.freshFormProof.candidateCount = 2;
        var candidateMismatch = Validate(duplicateCandidatePlan, new[] { new[] { "Project X" }, new[] { "Project X" } }, 1);

        bool initialProofMatches = WorkBuddyWindowsUiaComProbe.MatchesInitialQuestionProof(singlePlan, singleForm);
        singlePlan.freshFormProof.scopePathHash = "cccccccccccccccc";
        bool changedScopeRejected = !WorkBuddyWindowsUiaComProbe.MatchesInitialQuestionProof(singlePlan, singleForm);

        var identityHeadersWithSidebarDuplicate = new[] {
            new WorkBuddyWindowsUiaComProbe.PendingIdentityHeaderCandidate {
                path = "root/0/2/1", regionPath = "root/0/2", accessibleName = Title, offscreen = false
            },
            new WorkBuddyWindowsUiaComProbe.PendingIdentityHeaderCandidate {
                path = "root/1/0/1", regionPath = "root/1/0", accessibleName = Title, offscreen = false
            }
        };
        var selectedIdentityHeaders = WorkBuddyWindowsUiaComProbe.SelectPendingIdentityHeaders(
            Title, identityHeadersWithSidebarDuplicate, new[] { "root/0/2" });
        string verifiedDocumentRegion = "root/1/0";
        string composerRawNodePath = "root/1/0/4/2";
        string composerRawRegionPath = "root/1/0";
        string boundComposerGroupHash = "composer-group-hash";
        string headerDocumentRegionHash = "document-region-hash";
        bool composerRawRegionMatchesDespiteDifferentSummaryHash =
            boundComposerGroupHash != headerDocumentRegionHash &&
            WorkBuddyWindowsUiaComProbe.IsBoundComposerNodeInConversationRegion(
                verifiedDocumentRegion, composerRawNodePath, composerRawRegionPath);
        bool composerInOtherConversationRejected =
            !WorkBuddyWindowsUiaComProbe.IsBoundComposerNodeInConversationRegion(
                verifiedDocumentRegion, "root/2/0/4/2", "root/2/0");
        bool sidebarStopExcluded = WorkBuddyWindowsUiaComProbe.IsAtOrBelowConversationRowPath(
            "root/0/2/1/5", "root/0/2/1");
        bool currentConversationStopKept = !WorkBuddyWindowsUiaComProbe.IsAtOrBelowConversationRowPath(
            "root/1/0/3/4", "root/0/2/1");

        return new object[] {
            new { name = "questionPlanWithoutSourceId", result = new {
                valid = Validate(QuestionPlan(singleQuestion, singleAnswer, singleForm), new[] { new[] { "Project X" } }, 0),
                sourceQuestionId = singleQuestion.id,
                actionIntents = IntentSummary(singleIntents),
                nativeCallIdentifiersInPlan = typeof(WorkBuddyWindowsUiaComProbe.PendingActionPlan).GetProperties()
                    .Concat(typeof(WorkBuddyWindowsUiaComProbe.PendingFreshFormProof).GetProperties())
                    .Select(property => property.Name).Where(name => name.IndexOf("callId", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("turnId", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("requestId", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("sessionId", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("alias", StringComparison.OrdinalIgnoreCase) >= 0).ToArray()
            }},
            new { name = "multiSelectBaseline", result = new {
                derivedBaseline = derivedBaseline, derivedIntents = IntentSummary(derivedMultiIntents),
                nonzeroCountIntents = IntentSummary(nonzeroMultiIntents), missingOtherIntents = IntentSummary(missingOtherMultiIntents),
                submittedCountMatches = WorkBuddyWindowsUiaComProbe.IsMultiSelectCountObserved(postSelected, 0, 1, 2),
                wrongCountRejected = !WorkBuddyWindowsUiaComProbe.IsMultiSelectCountObserved(wrongCount, 0, 1, 2),
                missingCountRejected = !WorkBuddyWindowsUiaComProbe.IsMultiSelectCountObserved(derivedMultiForm, 0, 1, 2)
            }},
            new { name = "customAnswer", result = new {
                plan = Validate(customPlan, new[] { new[] { "Project X" } }, 0),
                intents = IntentSummary(customIntents), forbiddenPlan = Validate(customForbiddenPlan, new[] { new[] { "Project X" } }, 0),
                forbiddenIntents = IntentSummary(forbiddenIntents)
            }},
            new { name = "commandApproval", result = new {
                plan = Validate(commandPlan, new[] { new[] { "Project X" } }, 0),
                exactContext = WorkBuddyWindowsUiaComProbe.PendingCommandFormMatches(commandPlan, command),
                mismatchedCommandRejected = !WorkBuddyWindowsUiaComProbe.PendingCommandFormMatches(commandPlan, commandMismatch),
                relativeCwd = Validate(relativeCwd, new[] { new[] { "Project X" } }, 0),
                alwaysDecision = Validate(alwaysPlan, new[] { new[] { "Project X" } }, 0),
                truncationMarker = Validate(commandTruncationPlan, new[] { new[] { "Project X" } }, 0),
                ellipsisCommand = command.commandText
            }},
            new { name = "stopAndFreshIdentity", result = new {
                stopPlan = Validate(stopPlan, new[] { new[] { "Project X" } }, 0),
                candidateMismatch = candidateMismatch,
                initialProofMatches = initialProofMatches, changedScopeRejected = changedScopeRejected,
                cleanStatus = WorkBuddyWindowsUiaComProbe.IsFreshStatusComplete(validStatus, 2),
                exceptionStatusRejected = !WorkBuddyWindowsUiaComProbe.IsFreshStatusComplete(exceptionStatus, 2),
                earlyReturnStatusRejected = !WorkBuddyWindowsUiaComProbe.IsFreshStatusComplete(earlyReturnStatus, 2),
                nodeCountMismatchRejected = !WorkBuddyWindowsUiaComProbe.IsFreshStatusComplete(validStatus, 3),
                expiredBudgetStage = expiredBudgetReceipt.stage,
                expiredBudgetAttempted = expiredBudgetReceipt.attempted,
                expiredBudgetClockPreserved = Object.ReferenceEquals(originalBudgetClock, finalBudgetClock),
                expiredBudgetRemainsExpired = expiredBudgetRemainsExpired,
                sidebarDuplicateHeaderCount = identityHeadersWithSidebarDuplicate.Length,
                selectedHeaderCount = selectedIdentityHeaders.Length,
                selectedHeaderRegion = selectedIdentityHeaders.Length == 1 ? selectedIdentityHeaders[0].regionPath : "",
                composerRawRegionMatchesDespiteDifferentSummaryHash = composerRawRegionMatchesDespiteDifferentSummaryHash,
                composerInOtherConversationRejected = composerInOtherConversationRejected,
                sidebarStopExcluded = sidebarStopExcluded,
                currentConversationStopKept = currentConversationStopKept
            }}
        };
    }
}
`;

const FIXTURE_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string] $ComSourcePath,
  [Parameter(Mandatory=$true)][string] $PendingSourcePath,
  [Parameter(Mandatory=$true)][string] $ModelPopupSourcePath,
  [Parameter(Mandatory=$true)][string] $ActionsSourcePath,
  [Parameter(Mandatory=$true)][string] $FixtureSourcePath
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -Path @($ComSourcePath, $PendingSourcePath, $ModelPopupSourcePath, $ActionsSourcePath, (Join-Path (Split-Path -Parent $ComSourcePath) 'native-input.cs'), $FixtureSourcePath)
[WorkBuddyPendingActionsFixture]::Run() | ConvertTo-Json -Depth 14 -Compress
`;

test('pending action plans bind complete native forms, exact command scope, and a fresh unambiguous conversation', { skip: process.platform !== 'win32' }, () => {
  const question = fixtureResult('questionPlanWithoutSourceId');
  assert.equal(question.valid, 'valid');
  assert.equal(question.sourceQuestionId, null);
  assert.deepEqual(question.nativeCallIdentifiersInPlan, []);
  assert.deepEqual(question.actionIntents, [{ operation: 'invoke-option', label: 'Red' }]);

  const command = fixtureResult('commandApproval');
  assert.equal(command.plan, 'valid');
  assert.equal(command.exactContext, true);
  assert.equal(command.mismatchedCommandRejected, true);
  assert.equal(command.relativeCwd, 'invalid-plan');
  assert.equal(command.alwaysDecision, 'invalid-plan');
  assert.equal(command.truncationMarker, 'invalid-plan');
  assert.equal(command.ellipsisCommand, 'echo ...');

  const identity = fixtureResult('stopAndFreshIdentity');
  assert.equal(identity.stopPlan, 'valid');
  assert.notEqual(identity.candidateMismatch, 'valid');
  assert.equal(identity.initialProofMatches, true);
  assert.equal(identity.changedScopeRejected, true);
});

test('question actions distinguish auto-advance, multi-select cardinality, and Other submission', { skip: process.platform !== 'win32' }, () => {
  const multi = fixtureResult('multiSelectBaseline');
  assert.equal(multi.derivedBaseline, 'renderer-empty-omission-derived');
  assert.deepEqual(multi.derivedIntents.map(intent => intent.operation), ['invoke-option', 'invoke-option', 'invoke-send']);
  assert.deepEqual(multi.nonzeroCountIntents, []);
  assert.deepEqual(multi.missingOtherIntents, []);
  assert.equal(multi.submittedCountMatches, true);
  assert.equal(multi.wrongCountRejected, true);
  assert.equal(multi.missingCountRejected, true);

  const custom = fixtureResult('customAnswer');
  assert.equal(custom.plan, 'valid');
  assert.deepEqual(custom.intents.map(intent => intent.operation), ['set-other-value', 'invoke-send']);
  assert.notEqual(custom.forbiddenPlan, 'valid');
  assert.deepEqual(custom.forbiddenIntents, []);
});

test('fresh UIA proof rejects caught/early-return inspection errors as incomplete', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('stopAndFreshIdentity');
  assert.equal(result.cleanStatus, true);
  assert.equal(result.exceptionStatusRejected, true);
  assert.equal(result.earlyReturnStatusRejected, true);
  assert.equal(result.nodeCountMismatchRejected, true);
  assert.equal(result.expiredBudgetStage, 'helper-budget');
  assert.equal(result.expiredBudgetAttempted, false);
  assert.equal(result.expiredBudgetClockPreserved, true);
  assert.equal(result.expiredBudgetRemainsExpired, true);
  assert.equal(result.sidebarDuplicateHeaderCount, 2);
  assert.equal(result.selectedHeaderCount, 1);
  assert.equal(result.selectedHeaderRegion, 'root/1/0');
  assert.equal(result.composerRawRegionMatchesDespiteDifferentSummaryHash, true);
  assert.equal(result.composerInOtherConversationRejected, true);
  assert.equal(result.sidebarStopExcluded, true);
  assert.equal(result.currentConversationStopKept, true);
});

function fixtureResult(name) {
  const item = readPowerShellFixture().find(entry => entry.name === name);
  assert.ok(item, 'fixture ' + name + ' exists');
  return item.result;
}

let cachedFixture;
function readPowerShellFixture() {
  if (cachedFixture) return cachedFixture;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-pending-actions-'));
  const fixturePath = path.join(directory, 'PendingActionsFixture.cs');
  const scriptPath = path.join(directory, 'Run-PendingActionsFixture.ps1');
  try {
    fs.writeFileSync(fixturePath, FIXTURE_SOURCE, 'utf8');
    fs.writeFileSync(scriptPath, FIXTURE_SCRIPT, 'utf8');
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      COM_SOURCE, PENDING_SOURCE, MODEL_POPUP_SOURCE, ACTIONS_SOURCE, fixturePath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    cachedFixture = JSON.parse(output.trim());
    return cachedFixture;
  } finally {
    for (const target of [fixturePath, scriptPath]) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    try { fs.rmdirSync(directory); } catch {}
  }
}
