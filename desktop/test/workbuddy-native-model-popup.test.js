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
const POPUP_SOURCE = path.join(ROOT, 'desktop', 'src', 'workbuddy-native', 'model-popup.cs');

const FIXTURE_SOURCE = `
using System;
using System.Linq;
using System.Reflection;

public static class WorkBuddyModelPopupFixture
{
    private const string SelectorId = "1111111111111111";
    private const string SelectorRegion = "2222222222222222";
    private const string ComposerId = "3333333333333333";
    private const string Draft = "e3b0c44298fc1c14";
    private const string PopupId = "4444444444444444";
    private const string PopupRegion = "5555555555555555";
    private const string OptionAId = "6666666666666666";
    private const string OptionBId = "7777777777777777";

    private static WorkBuddyWindowsUiaComProbe.ModelPopupNodeEvidence Node(
        string path, int depth, int type, string automationId, string role,
        string accessibleName, string runtimeId, string region,
        bool enabled, bool offscreen, bool selectedKnown, bool selected, string ariaProperties)
    {
        return new WorkBuddyWindowsUiaComProbe.ModelPopupNodeEvidence {
            path = path, depth = depth, controlTypeId = type, automationId = automationId,
            ariaRole = role, ariaProperties = ariaProperties, accessibleName = accessibleName,
            runtimeIdHash = runtimeId, regionHash = region,
            enabledKnown = true, enabled = enabled, offscreenKnown = true, offscreen = offscreen,
            selectedKnown = selectedKnown, selected = selected
        };
    }

    private static WorkBuddyWindowsUiaComProbe.ModelPopupSnapshotEvidence Snapshot(
        int expansion, string controls, string[] controllerFor, bool controllerValid,
        WorkBuddyWindowsUiaComProbe.ModelPopupNodeEvidence[] nodes)
    {
        return new WorkBuddyWindowsUiaComProbe.ModelPopupSnapshotEvidence {
            complete = true, expansionState = expansion,
            selectorRuntimeIdHash = SelectorId, selectorRegionHash = SelectorRegion,
            composerRuntimeIdHash = ComposerId, draftFingerprint = Draft,
            currentModel = "Model-A", selectorAriaProperties = controls,
            controllerForValid = controllerValid,
            controllerForRuntimeIdHashes = controllerFor,
            nodes = nodes
        };
    }

    private static WorkBuddyWindowsUiaComProbe.ModelPopupSnapshotEvidence Before()
    {
        return Snapshot(0, String.Empty, new string[0], true,
            new WorkBuddyWindowsUiaComProbe.ModelPopupNodeEvidence[0]);
    }

    private static WorkBuddyWindowsUiaComProbe.ModelPopupSnapshotEvidence Expanded(
        string controls, string[] controllerFor, bool controllerValid)
    {
        var nodes = new[] {
            Node("root/portal/listbox", 3, 50008, "floating-listbox", "listbox", "", PopupId,
                PopupRegion, true, false, false, false, String.Empty),
            Node("root/portal/listbox/option-a", 4, 50007, "", "option", "Model-A", OptionAId,
                PopupRegion, true, false, true, true, String.Empty),
            Node("root/portal/listbox/option-b", 4, 50007, "", "option", "Model-B", OptionBId,
                PopupRegion, true, false, true, false, String.Empty)
        };
        return Snapshot(1, controls, controllerFor, controllerValid, nodes);
    }

    private static WorkBuddyWindowsUiaComProbe.ModelPopupInspection Project(
        WorkBuddyWindowsUiaComProbe.ModelPopupSnapshotEvidence before,
        WorkBuddyWindowsUiaComProbe.ModelPopupSnapshotEvidence expanded)
    {
        return WorkBuddyWindowsUiaComProbe.ProjectModelPopupEvidence(before, expanded, "Model-A");
    }

    private static object Case(string name, WorkBuddyWindowsUiaComProbe.ModelPopupInspection result)
    {
        return new { name = name, result = result };
    }

    public static object[] Run()
    {
        var exact = Project(Before(), Expanded("controls=floating-listbox", new string[0], true));
        var controllerFor = Project(Before(), Expanded(String.Empty, new[] { PopupId }, true));
        var missingAssociation = Project(Before(), Expanded(String.Empty, new string[0], true));
        var contradictoryAssociation = Project(Before(), Expanded("controls=floating-listbox",
            new[] { "8888888888888888" }, true));
        var invalidController = Project(Before(), Expanded("controls=floating-listbox", new string[0], false));

        var twoRoots = Expanded("controls=floating-listbox", new string[0], true);
        twoRoots.nodes = twoRoots.nodes.Concat(new[] {
            Node("root/portal/second-listbox", 3, 50008, "floating-listbox", "listbox", "", "9999999999999999",
                "aaaaaaaaaaaaaaaa", true, false, false, false, String.Empty)
        }).ToArray();

        var hiddenDuplicateRoot = Expanded("controls=floating-listbox", new string[0], true);
        hiddenDuplicateRoot.nodes = hiddenDuplicateRoot.nodes.Concat(new[] {
            Node("root/portal/hidden-listbox", 3, 50008, "floating-listbox", "listbox", "", "9999999999999999",
                PopupRegion, true, true, false, false, String.Empty)
        }).ToArray();

        var nearbyOption = Expanded("controls=floating-listbox", new string[0], true);
        nearbyOption.nodes = nearbyOption.nodes.Concat(new[] {
            Node("root/portal/other/option-a", 4, 50007, "", "option", "Model-A", "bbbbbbbbbbbbbbbb",
                PopupRegion, true, false, true, true, String.Empty)
        }).ToArray();

        var duplicateName = Expanded("controls=floating-listbox", new string[0], true);
        duplicateName.nodes[2].accessibleName = "Model-A";

        var duplicateRuntimeId = Expanded("controls=floating-listbox", new string[0], true);
        duplicateRuntimeId.nodes[2].runtimeIdHash = OptionAId;

        var missingSelected = Expanded("controls=floating-listbox", new string[0], true);
        missingSelected.nodes[1].selected = false;

        var wrongCurrentModel = Expanded("controls=floating-listbox", new string[0], true);
        wrongCurrentModel.nodes[1].accessibleName = "Model-X";

        var hiddenOption = Expanded("controls=floating-listbox", new string[0], true);
        hiddenOption.nodes[2].offscreen = true;

        var unknownOptionState = Expanded("controls=floating-listbox", new string[0], true);
        unknownOptionState.nodes[2].offscreenKnown = false;

        var wrongRole = Expanded("controls=floating-listbox", new string[0], true);
        wrongRole.nodes[0].ariaRole = "menu";
        wrongRole.nodes[0].controlTypeId = 50026;

        var optionRoleUnverified = Expanded("controls=floating-listbox", new string[0], true);
        optionRoleUnverified.nodes[1].ariaRole = "menuitem";

        var truncated = Expanded("controls=floating-listbox", new string[0], true);
        truncated.complete = false;

        var wrongFrame = Expanded("controls=floating-listbox", new string[0], true);
        wrongFrame.draftFingerprint = "aaaaaaaaaaaaaaaa";

        var multipleControlTokens = Expanded("controls=floating-listbox;controls=other", new string[0], true);
        var multipleControlReferences = Expanded("controls=floating-listbox other-widget", new string[0], true);
        var unsafeId = Expanded("controls=bad id", new string[0], true);
        var escapedControlValue = Expanded("controls=floating\\\\;listbox", new string[0], true);
        var sourceRoleNameProjection = new[] {
            new { name = "one visible text node", actual = WorkBuddyWindowsUiaComProbe.ProjectModelPopupOptionName("", new[] { "Model-A" }) },
            new { name = "multiple text nodes are ambiguous", actual = WorkBuddyWindowsUiaComProbe.ProjectModelPopupOptionName("", new[] { "Model-A", "Provider subtitle" }) },
            new { name = "direct accessible name preferred", actual = WorkBuddyWindowsUiaComProbe.ProjectModelPopupOptionName("Model-B", new[] { "Model-A" }) },
            new { name = "unsafe credential-like name rejected", actual = WorkBuddyWindowsUiaComProbe.ProjectModelPopupOptionName("token=hidden", new[] { "token=hidden" }) }
        };

        Type resultType = typeof(WorkBuddyWindowsUiaComProbe.ModelPopupInspection);
        string[] resultProperties = resultType.GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        Type optionType = typeof(WorkBuddyWindowsUiaComProbe.ModelPopupOption);
        string[] optionProperties = optionType.GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray();
        Type elementArrayType = typeof(WorkBuddyWindowsUiaComProbe.WorkBuddyIUIAutomationElementArray);
        string[] elementArrayMethods = elementArrayType.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .Where(method => method.DeclaringType == elementArrayType)
            .OrderBy(method => method.MetadataToken)
            .Select(method => method.Name).ToArray();

        return new object[] {
            Case("exactAriaControls", exact),
            Case("controllerFor", controllerFor),
            Case("missingAssociation", missingAssociation),
            Case("contradictoryAssociation", contradictoryAssociation),
            Case("invalidController", invalidController),
            Case("twoRoots", Project(Before(), twoRoots)),
            Case("hiddenDuplicateRoot", Project(Before(), hiddenDuplicateRoot)),
            Case("nearbyOption", Project(Before(), nearbyOption)),
            Case("duplicateName", Project(Before(), duplicateName)),
            Case("duplicateRuntimeId", Project(Before(), duplicateRuntimeId)),
            Case("missingSelected", Project(Before(), missingSelected)),
            Case("wrongCurrentModel", Project(Before(), wrongCurrentModel)),
            Case("hiddenOption", Project(Before(), hiddenOption)),
            Case("unknownOptionState", Project(Before(), unknownOptionState)),
            Case("wrongRole", Project(Before(), wrongRole)),
            Case("optionRoleUnverified", Project(Before(), optionRoleUnverified)),
            Case("truncated", Project(Before(), truncated)),
            Case("wrongFrame", Project(Before(), wrongFrame)),
            Case("multipleControlTokens", Project(Before(), multipleControlTokens)),
            Case("multipleControlReferences", Project(Before(), multipleControlReferences)),
            Case("unsafeId", Project(Before(), unsafeId)),
            Case("escapedControlValue", Project(Before(), escapedControlValue)),
            new { name = "optionNameProjection", result = sourceRoleNameProjection },
            new { name = "closedOutputShape", result = new { resultProperties = resultProperties, optionProperties = optionProperties } },
            new { name = "controllerForSdkShape", result = new { iid = elementArrayType.GUID.ToString("D").ToLowerInvariant(),
                isComImport = elementArrayType.IsImport, methods = elementArrayMethods } }
        };
    }
}
`;

const FIXTURE_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string] $ComSourcePath,
  [Parameter(Mandatory=$true)][string] $PendingSourcePath,
  [Parameter(Mandatory=$true)][string] $PopupSourcePath,
  [Parameter(Mandatory=$true)][string] $FixtureSourcePath
)
$ErrorActionPreference = 'Stop'
Add-Type -Path @($ComSourcePath, $PendingSourcePath, $PopupSourcePath, (Join-Path (Split-Path -Parent $ComSourcePath) 'pending-actions.cs'), (Join-Path (Split-Path -Parent $ComSourcePath) 'native-input.cs'), $FixtureSourcePath)
[WorkBuddyModelPopupFixture]::Run() | ConvertTo-Json -Depth 14 -Compress
`;

test('model popup reader uses the documented read-only UIA relationship properties and bounded evidence', () => {
  const source = fs.readFileSync(POPUP_SOURCE, 'utf8');
  assert.match(source, /ModelPopupAutomationIdPropertyId = 30011/);
  assert.match(source, /ModelPopupAriaRolePropertyId = 30101/);
  assert.match(source, /ModelPopupAriaPropertiesPropertyId = 30102/);
  assert.match(source, /ModelPopupControllerForPropertyId = 30104/);
  assert.match(source, /Guid\("14314595-B4BC-4055-95F2-58F2E42C9855"\)/i);
  assert.match(source, /get_Length\(out int length\)/);
  assert.match(source, /GetElement\(int index, out WorkBuddyIUIAutomationElement element\)/);
  assert.match(source, /raw as WorkBuddyIUIAutomationElementArray/);
  assert.match(source, /elements\.get_Length\(out length\)/);
  assert.match(source, /elements\.GetElement\(index, out controlled\)/);
  assert.ok((source.match(/\[ComImport/g) || []).length === 2, 'only the SDK element-array and ScrollItem interfaces are added');
  assert.match(source, /Marshal\.ReleaseComObject\(controlled\)/);
  assert.match(source, /Marshal\.ReleaseComObject\(elements\)/);
  assert.match(source, /snapshot\.status\.traversalTruncated/);
  assert.match(source, /snapshot\.AllNodeReferences\.Length == snapshot\.status\.traversedNodes/);
  assert.match(source, /snapshot\.NodeTypeByPath\.Count == snapshot\.AllNodeReferences\.Length/);
  assert.match(source, /ariaRole, "listbox"/);
  assert.match(source, /ariaRole, "option"/);
  assert.match(source, /controlledIds\.Contains\(root\.automationId/);
  assert.match(source, /controllerForRuntimeIdHashes\.Contains\(root\.runtimeIdHash/);
  assert.match(source, /ProjectModelPopupOptionName/);
  const reader = source.slice(0, source.indexOf('public sealed class ModelSelectionReceipt'));
  assert.doesNotMatch(reader, /\.Expand\s*\(|\.Collapse\s*\(|\.Select\s*\(|\.Invoke\s*\(|SetValue\s*\(/);
  assert.doesNotMatch(source, /requestId|turnId|nativeUuid|rpc/i);
});

test('exact ARIA controls association returns only native option names and hashes', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('exactAriaControls');
  assert.equal(result.complete, true);
  assert.equal(result.reason, null);
  assert.equal(result.selectedCurrentModelCount, 1);
  assert.deepEqual(result.options.map(option => option.modelName), ['Model-A', 'Model-B']);
  assert.equal(result.options[0].selected, true);
  assert.equal(result.options[0].runtimeIdHash, '6666666666666666');
  assert.notEqual(result.popupAutomationIdHash, 'floating-listbox');
});

test('ControllerFor can associate the exact popup when aria-controls is absent', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('controllerFor');
  assert.equal(result.complete, true);
  assert.deepEqual(result.options.map(option => option.modelName), ['Model-A', 'Model-B']);
});

test('popup association fails closed when the native relationship is missing or ambiguous', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['missingAssociation', 'contradictoryAssociation', 'invalidController', 'twoRoots', 'hiddenDuplicateRoot', 'multipleControlTokens', 'multipleControlReferences', 'unsafeId', 'escapedControlValue']) {
    const result = fixtureResult(name);
    assert.equal(result.complete, false, name);
    assert.deepEqual(result.options, [], name);
  }
  assert.equal(fixtureResult('twoRoots').reason, 'listbox-relationship-ambiguous');
});

test('options outside the associated listbox do not leak into the model catalog', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('nearbyOption');
  assert.equal(result.complete, true);
  assert.deepEqual(result.options.map(option => option.modelName), ['Model-A', 'Model-B']);
});

test('popup projection rejects hidden, duplicate, incomplete, or unselected option sets', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['duplicateName', 'duplicateRuntimeId', 'missingSelected', 'wrongCurrentModel', 'unknownOptionState', 'wrongRole', 'optionRoleUnverified', 'truncated', 'wrongFrame']) {
    const result = fixtureResult(name);
    assert.equal(result.complete, false, name);
    assert.deepEqual(result.options, [], name);
  }
});

test('offscreen model options in the exact controlled list remain readable catalog entries', { skip: process.platform !== 'win32' }, () => {
  const result = fixtureResult('hiddenOption');
  assert.equal(result.complete, true);
  assert.deepEqual(result.options.map(o => o.modelName), ['Model-A','Model-B']);
});

test('option naming uses one unambiguous visible native text child when no direct accessible name exists', { skip: process.platform !== 'win32' }, () => {
  const cases = fixtureResult('optionNameProjection');
  assert.equal(cases[0].actual, 'Model-A');
  assert.equal(cases[1].actual, '');
  assert.equal(cases[2].actual, 'Model-B');
  assert.equal(cases[3].actual, '');
});

test('model popup DTOs expose a closed set of local evidence fields', { skip: process.platform !== 'win32' }, () => {
  const shape = fixtureResult('closedOutputShape');
  assert.deepEqual(shape.resultProperties, [
    'complete', 'options', 'popupAutomationIdHash', 'popupRuntimeIdHash', 'reason',
    'selectedCurrentModelCount', 'selectorRegionHash', 'selectorRuntimeIdHash',
  ]);
  assert.deepEqual(shape.optionProperties, [
    'enabled', 'modelName', 'pathHash', 'regionHash', 'runtimeIdHash', 'selected',
  ]);
});

test('ControllerFor uses the Microsoft SDK element-array IID and IUnknown vtable method order', { skip: process.platform !== 'win32' }, () => {
  const shape = fixtureResult('controllerForSdkShape');
  assert.equal(shape.iid, '14314595-b4bc-4055-95f2-58f2e42c9855');
  assert.equal(shape.isComImport, true);
  assert.deepEqual(shape.methods, ['get_Length', 'GetElement']);
});

function fixtureResult(name) {
  const item = readPowerShellFixture().find(entry => entry.name === name);
  assert.ok(item, 'fixture ' + name + ' exists');
  return item.result;
}

let cachedFixture;
function readPowerShellFixture() {
  if (cachedFixture) return cachedFixture;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-model-popup-'));
  const fixturePath = path.join(directory, 'ModelPopupFixture.cs');
  const scriptPath = path.join(directory, 'Run-ModelPopupFixture.ps1');
  try {
    fs.writeFileSync(fixturePath, FIXTURE_SOURCE, 'utf8');
    fs.writeFileSync(scriptPath, FIXTURE_SCRIPT, 'utf8');
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      COM_SOURCE, PENDING_SOURCE, POPUP_SOURCE, fixturePath,
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
