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

const FIXTURE_SOURCE = `
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

public static class WorkBuddyPendingReaderFixture
{
    private static WorkBuddyWindowsUiaComProbe.PendingControlDescriptor Control(
        string type, string name, string path, string runtimeId, string region, string[] patterns)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingControlDescriptor {
            controlType = type,
            accessibleName = name,
            enabled = true,
            patterns = patterns,
            pathHash = path,
            runtimeIdHash = runtimeId,
            regionHash = region,
            passwordProtected = false
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormEvidence Question(
        string path, string region, bool missingRuntime, bool password, bool credential)
    {
        string runtime = missingRuntime ? String.Empty : "0123456789abcdef";
        var controls = new List<WorkBuddyWindowsUiaComProbe.PendingControlDescriptor> {
            Control("ControlType.Button", "Previous question", "1111111111111111", runtime, region, new[] { "invoke" }),
            Control("ControlType.Button", "Next question", "2222222222222222", "2222222222222222", region, new[] { "invoke" }),
            Control("ControlType.Button", "Send", "3333333333333333", "3333333333333333", region, new[] { "invoke" }),
            Control("ControlType.Button", "Red", "4444444444444444", "4444444444444444", region, new[] { "invoke" }),
            Control("ControlType.Button", "Blue", "5555555555555555", "5555555555555555", region, new[] { "invoke" }),
            Control("ControlType.Edit", "Other (type your answer)", "6666666666666666", "6666666666666666", region, new[] { "value" }),
            Control("ControlType.Text", null, "7777777777777777", String.Empty, region, new[] { "text" })
        };
        if (password) controls[5].passwordProtected = true;
        return new WorkBuddyWindowsUiaComProbe.PendingFormEvidence {
            kind = "question",
            scopePath = path,
            regionPath = "root/0/document",
            visibleText = credential ? "What is your password?\\nRed\\nBlue" : "Which color do you prefer?\\nRed\\nBlue",
            commandText = String.Empty,
            controls = controls.ToArray(),
            uniqueScope = true,
            completeSignature = true,
            completeText = true,
            textTruncated = false,
            containsCredential = credential,
            hasPasswordField = password,
            hasUnexpectedEdit = false,
            hasUnsupportedDecision = false
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormEvidence Command(
        string path, string region, string command, bool unsupportedDecision)
    {
        var controls = new List<WorkBuddyWindowsUiaComProbe.PendingControlDescriptor> {
            Control("ControlType.Button", "Run", "8888888888888888", "8888888888888888", region, new[] { "invoke" }),
            Control("ControlType.Button", "Skip", "9999999999999999", "9999999999999999", region, new[] { "invoke" }),
            Control("ControlType.Button", "Reject", "aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa", region, new[] { "invoke" }),
            Control("ControlType.Text", null, "bbbbbbbbbbbbbbbb", String.Empty, region, new[] { "text" }),
            Control("ControlType.Text", null, "cccccccccccccccc", String.Empty, region, new[] { "text" })
        };
        if (unsupportedDecision)
            controls.Add(Control("ControlType.Button", "Allow once", "dddddddddddddddd", "dddddddddddddddd", region, new[] { "invoke" }));
        return new WorkBuddyWindowsUiaComProbe.PendingFormEvidence {
            kind = "command",
            scopePath = path,
            regionPath = "root/0/document",
            visibleText = "bash\\n" + command,
            commandText = command,
            controls = controls.ToArray(),
            uniqueScope = true,
            completeSignature = true,
            completeText = true,
            textTruncated = false,
            containsCredential = false,
            hasPasswordField = false,
            hasUnexpectedEdit = false,
            hasUnsupportedDecision = unsupportedDecision
        };
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormEvidence QuestionWithText(
        string path, string region, string text, bool truncated)
    {
        var evidence = Question(path, region, false, false, false);
        evidence.visibleText = text;
        evidence.textTruncated = truncated;
        return evidence;
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormEvidence LocalizedQuestion(
        string path, string region, string text)
    {
        var evidence = QuestionWithText(path, region, text, false);
        evidence.controls[0].accessibleName = "\\u4E0A\\u4E00\\u9898";
        evidence.controls[1].accessibleName = "\\u4E0B\\u4E00\\u9898";
        evidence.controls[2].accessibleName = "\\u53D1\\u9001";
        evidence.controls[5].accessibleName = "\\u5176\\u4ED6\\uFF08\\u8F93\\u5165\\u4F60\\u7684\\u7B54\\u6848\\uFF09";
        return evidence;
    }

    private static WorkBuddyWindowsUiaComProbe.PendingFormsResult Project(
        params WorkBuddyWindowsUiaComProbe.PendingFormEvidence[] evidence)
    {
        return WorkBuddyWindowsUiaComProbe.ProjectPendingFormsEvidence(true, true, evidence);
    }

    private static WorkBuddyWindowsUiaComProbe.PendingScopeEvidence Scope(
        string kind, string path, int previous, int next, int send, int run, int skip, int reject)
    {
        return new WorkBuddyWindowsUiaComProbe.PendingScopeEvidence {
            kind = kind, scopePath = path, previousCount = previous, nextCount = next,
            sendCount = send, runCount = run, skipCount = skip, rejectCount = reject
        };
    }

    public static object[] Run()
    {
        var errorTypeSnapshot = new WorkBuddyWindowsUiaComProbe.Result {
            status = new WorkBuddyWindowsUiaComProbe.Status {
                traversedNodes = 1, traversalTruncated = false, errorType = "COMException", errorStage = String.Empty
            }
        };
        var errorStageSnapshot = new WorkBuddyWindowsUiaComProbe.Result {
            status = new WorkBuddyWindowsUiaComProbe.Status {
                traversedNodes = 1, traversalTruncated = false, errorType = null, errorStage = "raw-view-walker"
            }
        };
        var errorStatusRejected = new {
            errorType = WorkBuddyWindowsUiaComProbe.InspectPendingForms(errorTypeSnapshot, "Project X").reason,
            errorStage = WorkBuddyWindowsUiaComProbe.InspectPendingForms(errorStageSnapshot, "Project X").reason
        };
        var question = Project(Question("root/0/document/group/question-a", "e58a16f337483111", false, false, false));
        var multiple = Project(
            Question("root/0/document/group/question-a", "e58a16f337483111", false, false, false),
            Question("root/0/document/group/question-b", "e58a16f337483111", false, false, false),
            Command("root/0/document/group/command-a", "e58a16f337483111", "Get-ChildItem", false));
        var password = Project(Question("root/0/document/group/question-a", "e58a16f337483111", false, true, false));
        var credential = Project(Question("root/0/document/group/question-a", "e58a16f337483111", false, false, true));
        var accountEllipsis = Project(QuestionWithText("root/0/document/group/question-a", "e58a16f337483111",
            "Which account is right...?\\nRed\\nBlue", false));
        var localizedQuestion = Project(LocalizedQuestion("root/0/document/group/question-a", "e58a16f337483111",
            "1/3\\n\\u5DF2\\u9009\\u62E9 2 \\u4E2A\\n\\u559C\\u6B22\\u54EA\\u4E2A\\u989C\\u8272\\uFF1F\\n\\u7EA2\\u8272\\n\\u84DD\\u8272"));
        var progressAmbiguous = Project(QuestionWithText("root/0/document/group/question-a", "e58a16f337483111",
            "1/3\\n2/3\\nWhich color?\\nRed\\nBlue", false));
        var credentialValue = Project(QuestionWithText("root/0/document/group/question-a", "e58a16f337483111",
            "Choose an option\\nAPI_KEY=demo-value\\nRed\\nBlue", false));
        var truncationMetadata = Project(QuestionWithText("root/0/document/group/question-a", "e58a16f337483111",
            "Which option...?\\nRed\\nBlue", true));
        var truncated = WorkBuddyWindowsUiaComProbe.ProjectPendingFormsEvidence(
            false, true, new[] { Question("root/0/document/group/question-a", "e58a16f337483111", false, false, false) });
        var missingRuntime = Project(Question("root/0/document/group/question-a", "e58a16f337483111", true, false, false));
        var duplicateScope = Project(
            Question("root/0/document/group/question-a", "e58a16f337483111", false, false, false),
            Question("root/0/document/group/question-a", "e58a16f337483111", false, false, false));
        var command = Project(Command("root/0/document/group/command-a", "e58a16f337483111", "Get-ChildItem", false));
        var ellipsisCommand = Project(Command("root/0/document/group/command-a", "e58a16f337483111", "echo ...", false));
        var unsupportedCommand = Project(Command("root/0/document/group/command-a", "e58a16f337483111", "Get-ChildItem", true));
        var truncatedCommand = Project(Command("root/0/document/group/command-a", "e58a16f337483111", "git status [truncated]", false));
        var textTruncationEvidence = new {
            commandEllipsis = WorkBuddyWindowsUiaComProbe.HasPendingTextTruncationEvidence("echo ...", 4000),
            unicodeEllipsis = WorkBuddyWindowsUiaComProbe.HasPendingTextTruncationEvidence("ask … later", 4000),
            measuredOverLimit = WorkBuddyWindowsUiaComProbe.HasPendingTextTruncationEvidence(new string('x', 4001), 4000),
            providerMarker = WorkBuddyWindowsUiaComProbe.HasPendingTextTruncationEvidence("output [truncated]", 4000),
            accountWording = WorkBuddyWindowsUiaComProbe.HasPendingTextTruncationEvidence("Which account should I use?", 4000)
        };
        var scopeSelection = new {
            nestedQuestion = WorkBuddyWindowsUiaComProbe.SelectClosestPendingScopePaths(new[] {
                Scope("question", "root/document/conversation-pane", 1, 1, 1, 0, 0, 0),
                Scope("question", "root/document/conversation-pane/question-form", 1, 1, 1, 0, 0, 0)
            }, "question", true),
            multipleQuestions = WorkBuddyWindowsUiaComProbe.SelectClosestPendingScopePaths(new[] {
                Scope("question", "root/document/conversation-pane", 2, 2, 2, 0, 0, 0),
                Scope("question", "root/document/conversation-pane/question-a", 1, 1, 1, 0, 0, 0),
                Scope("question", "root/document/conversation-pane/question-b", 1, 1, 1, 0, 0, 0)
            }, "question", true),
            commandRunReject = WorkBuddyWindowsUiaComProbe.SelectClosestPendingScopePaths(new[] {
                Scope("command", "root/document/command-form", 0, 0, 0, 1, 1, 1)
            }, "command", true),
            partialQuestion = WorkBuddyWindowsUiaComProbe.SelectClosestPendingScopePaths(new[] {
                Scope("question", "root/document/question-form", 1, 0, 0, 0, 0, 0)
            }, "question", false)
        };

        Type evidenceType = typeof(WorkBuddyWindowsUiaComProbe.PendingFormEvidence);
        string[] evidenceFields = evidenceType.GetFields(BindingFlags.Instance | BindingFlags.NonPublic)
            .Select(field => field.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        var closedEvidenceShape = new {
            isSealed = evidenceType.IsSealed,
            fields = evidenceFields,
            hasDynamicDictionary = evidenceType.GetFields(BindingFlags.Instance | BindingFlags.NonPublic)
                .Any(field => typeof(System.Collections.IDictionary).IsAssignableFrom(field.FieldType))
        };

        return new object[] {
            new { name = "errorStatusRejected", result = errorStatusRejected },
            new { name = "question", result = question },
            new { name = "multiple", result = multiple },
            new { name = "password", result = password },
            new { name = "credential", result = credential },
            new { name = "accountEllipsis", result = accountEllipsis },
            new { name = "localizedQuestion", result = localizedQuestion },
            new { name = "progressAmbiguous", result = progressAmbiguous },
            new { name = "credentialValue", result = credentialValue },
            new { name = "truncationMetadata", result = truncationMetadata },
            new { name = "truncated", result = truncated },
            new { name = "missingRuntime", result = missingRuntime },
            new { name = "duplicateScope", result = duplicateScope },
            new { name = "command", result = command },
            new { name = "ellipsisCommand", result = ellipsisCommand },
            new { name = "unsupportedCommand", result = unsupportedCommand },
            new { name = "truncatedCommand", result = truncatedCommand },
            new { name = "textTruncationEvidence", result = textTruncationEvidence },
            new { name = "scopeSelection", result = scopeSelection },
            new { name = "closedEvidenceShape", result = closedEvidenceShape }
        };
    }
}
`;

const FIXTURE_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string] $ComSourcePath,
  [Parameter(Mandatory=$true)][string] $PendingSourcePath,
  [Parameter(Mandatory=$true)][string] $ModelPopupSourcePath,
  [Parameter(Mandatory=$true)][string] $FixtureSourcePath
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -Path @($ComSourcePath, $PendingSourcePath, $ModelPopupSourcePath, (Join-Path (Split-Path -Parent $ComSourcePath) 'pending-actions.cs'), (Join-Path (Split-Path -Parent $ComSourcePath) 'native-input.cs'), $FixtureSourcePath)
[WorkBuddyPendingReaderFixture]::Run() | ConvertTo-Json -Depth 14 -Compress
`;

test('pending form reader is read-only, bounded, and exposes no bridge request or turn identity', () => {
  const source = fs.readFileSync(PENDING_SOURCE, 'utf8');
  assert.match(source, /InspectPendingForms\(Result snapshot, string identityTitle\)/);
  assert.match(source, /snapshot\.AllNodeReferences\.Length != snapshot\.status\.traversedNodes/);
  assert.match(source, /snapshot\.status\.traversalTruncated/);
  assert.match(source, /ConversationRowTitle/);
  assert.match(source, /TwoPathCommonAncestor/);
  assert.match(source, /PendingMaxForms = 8/);
  assert.match(source, /PendingMaxControls = 128/);
  assert.match(source, /HasPendingTextTruncationEvidence\(string value, int maxLength\)/);
  assert.doesNotMatch(source, /PendingSensitiveTopicPattern/);
  assert.doesNotMatch(source, /(?:\\u2026|…|\\.\{3\})/);
  assert.doesNotMatch(source, /ValuePropertyId|CurrentValue|GetCurrentValue/);
  assert.doesNotMatch(source, /requestId|turnId|nativeUuid|RPC/);
});

test('pending form reader refuses snapshots with a caught inspection error or incomplete stage', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('errorStatusRejected');
  assert.equal(result.errorType, 'snapshot-incomplete');
  assert.equal(result.errorStage, 'snapshot-incomplete');
});

test('pending evidence uses a closed DTO shape rather than dynamic or prototype-backed input', { skip: process.platform !== 'win32' }, () => {
  const fixture = readPowerShellFixture();
  const shape = fixtureResult('closedEvidenceShape');
  assert.equal(shape.isSealed, true);
  assert.equal(shape.hasDynamicDictionary, false);
  assert.deepEqual(shape.fields.sort(), [
    'commandText',
    'completeSignature',
    'completeText',
    'containsCredential',
    'hasPasswordField',
    'hasUnexpectedEdit',
    'hasUnsupportedDecision',
    'kind',
    'regionPath',
    'scopePath',
    'uniqueScope',
    'visibleText',
    'controls',
    'textTruncated',
  ].sort());
});

test('exact question group projects only complete visible question context and its controls', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('question');
  assert.equal(result.snapshotComplete, true);
  assert.equal(result.conversationIdentityVerified, true);
  assert.equal(result.forms.length, 1);
  assert.equal(result.forms[0].kind, 'question');
  assert.equal(result.forms[0].complete, true);
  assert.equal(result.forms[0].desktopGuide, false);
  assert.match(result.forms[0].visibleText, /Which color do you prefer/);
  assert.equal(result.forms[0].commandText, '');
  assert.equal(result.forms[0].controls.length, 7);
  assert.equal(result.forms[0].controls.every((control) => /^[a-f0-9]{16}$/.test(control.pathHash)), true);
  assert.equal(result.forms[0].controls.every((control) => control.regionHash === result.forms[0].conversationRegionHash), true);
  assert.equal(result.forms[0].pageIndex, null);
  assert.equal(result.forms[0].pageCount, null);
  assert.equal(result.forms[0].questionIndexSource, 'unavailable');
  assert.equal(result.forms[0].selectedCount, null);
  assert.equal(result.forms[0].selectedCountSource, 'unavailable');
});

test('localized question controls stay actionable and only unique visible progress/count become typed evidence', { skip: process.platform !== 'win32' }, () => {
  const localized = fixtureResult('localizedQuestion');
  const form = localized.forms[0];
  assert.equal(form.complete, true);
  assert.match(form.visibleText, /1\/3/);
  assert.match(form.visibleText, /已选择 2 个/);
  assert.equal(form.pageIndex, 1);
  assert.equal(form.pageCount, 3);
  assert.equal(form.questionIndexSource, 'native-progress');
  assert.equal(form.selectedCount, 2);
  assert.equal(form.selectedCountSource, 'native-visible-count');
  assert.deepEqual(form.controls.filter((control) => ['上一题', '下一题', '发送'].includes(control.accessibleName))
    .map((control) => control.accessibleName), ['上一题', '下一题', '发送']);
  assert.equal(form.controls.some((control) => control.accessibleName === '其他（输入你的答案）'), true);

  const ambiguous = fixtureResult('progressAmbiguous').forms[0];
  assert.equal(ambiguous.complete, true);
  assert.equal(ambiguous.pageIndex, null);
  assert.equal(ambiguous.pageCount, null);
  assert.equal(ambiguous.questionIndexSource, 'unavailable');
});

test('native group selection chooses the closest exact form and keeps multiple forms disjoint', { skip: process.platform !== 'win32' }, () => {
  const selection = fixtureResult('scopeSelection');
  assert.deepEqual(selection.nestedQuestion, ['root/document/conversation-pane/question-form']);
  assert.deepEqual(selection.multipleQuestions, [
    'root/document/conversation-pane/question-a',
    'root/document/conversation-pane/question-b',
  ]);
  assert.deepEqual(selection.commandRunReject, ['root/document/command-form']);
  assert.deepEqual(selection.partialQuestion, ['root/document/question-form']);
});

test('multiple unique forms remain separate and command scope requires Run plus Reject', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('multiple');
  assert.equal(result.forms.length, 3);
  assert.equal(result.forms.every((form) => form.complete), true);
  assert.equal(new Set(result.forms.map((form) => form.scopePathHash)).size, 3);
  const command = result.forms.find((form) => form.kind === 'command');
  assert.equal(command.commandText, 'Get-ChildItem');
  assert.deepEqual(command.controls.filter((control) => ['Run', 'Skip', 'Reject'].includes(control.accessibleName))
    .map((control) => control.accessibleName).sort(), ['Reject', 'Run', 'Skip']);
});

test('ordinary account wording and ellipses remain valid while password fields and credential values stay private', { skip: process.platform !== 'win32' }, () => {
  const account = fixtureResult('accountEllipsis');
  assert.equal(account.forms[0].complete, true);
  assert.match(account.forms[0].visibleText, /Which account is right\.\.\.\?/);

  for (const name of ['password', 'credential', 'missingRuntime']) {
    const result = fixtureResult(name);
    assert.equal(result.forms[0].complete, false, name);
    assert.equal(result.forms[0].desktopGuide, true, name);
    assert.deepEqual(result.forms[0].controls, [], name);
    assert.equal(result.forms[0].visibleText, '', name);
    assert.equal(result.forms[0].commandText, '', name);
  }

  for (const name of ['credentialValue', 'truncationMetadata']) {
    const result = fixtureResult(name);
    assert.equal(result.forms[0].complete, false, name);
    assert.equal(result.forms[0].desktopGuide, true, name);
    assert.deepEqual(result.forms[0].controls, [], name);
    assert.equal(result.forms[0].visibleText, '', name);
  }

  const truncated = fixtureResult('truncated');
  assert.equal(truncated.snapshotComplete, false);
  assert.deepEqual(truncated.forms, []);

  const duplicate = fixtureResult('duplicateScope');
  assert.equal(duplicate.forms.length, 2);
  assert.equal(duplicate.forms.every((form) => form.complete === false), true);
  assert.equal(duplicate.forms.every((form) => form.desktopGuide === true), true);
});

test('command ellipses remain content; explicit truncation markers and session approvals cannot become command scope', { skip: process.platform !== 'win32' }, () => {
  const accepted = fixtureResult('command');
  assert.equal(accepted.forms[0].complete, true);
  assert.equal(accepted.forms[0].commandText, 'Get-ChildItem');

  const ellipsis = fixtureResult('ellipsisCommand');
  assert.equal(ellipsis.forms[0].complete, true);
  assert.equal(ellipsis.forms[0].commandText, 'echo ...');

  for (const name of ['unsupportedCommand', 'truncatedCommand']) {
    const blocked = fixtureResult(name);
    assert.equal(blocked.forms[0].complete, false, name);
    assert.equal(blocked.forms[0].desktopGuide, true, name);
    assert.deepEqual(blocked.forms[0].controls, [], name);
    assert.equal(blocked.forms[0].commandText, '', name);
  }
});

test('truncation evidence uses native markers or measured length, never ellipsis or topic words', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('textTruncationEvidence');
  assert.equal(result.commandEllipsis, false);
  assert.equal(result.unicodeEllipsis, false);
  assert.equal(result.accountWording, false);
  assert.equal(result.measuredOverLimit, true);
  assert.equal(result.providerMarker, true);
});

function fixtureResult(name) {
  const fixture = readPowerShellFixture();
  const item = fixture.find((entry) => entry.name === name);
  assert.ok(item, 'fixture ' + name + ' exists');
  return item.result;
}

let cachedFixture;
function readPowerShellFixture() {
  if (cachedFixture) return cachedFixture;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-pending-reader-'));
  const fixturePath = path.join(directory, 'PendingReaderFixture.cs');
  const scriptPath = path.join(directory, 'Run-PendingReaderFixture.ps1');
  try {
    fs.writeFileSync(fixturePath, FIXTURE_SOURCE, 'utf8');
    fs.writeFileSync(scriptPath, FIXTURE_SCRIPT, 'utf8');
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      COM_SOURCE, PENDING_SOURCE, MODEL_POPUP_SOURCE, fixturePath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    cachedFixture = JSON.parse(output.trim());
    return cachedFixture;
  } finally {
    for (const target of [fixturePath, scriptPath]) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(directory);
  }
}
