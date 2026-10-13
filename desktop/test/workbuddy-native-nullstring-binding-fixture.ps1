$ErrorActionPreference = 'Stop'

$fixtureSource = @'
using System;
public static class OptionalStringBindingFixture
{
    public static string Describe(string value)
    {
        return value == null ? "null" : value.Length == 0 ? "empty" : "nonempty";
    }

    // Mirrors ExecuteSemanticAction's initial argument and no-conversation
    // guards. This fixture exercises real Windows PowerShell-to-C# binding,
    // without inspecting or acting on a WorkBuddy window.
    public static string NextStage(string identityTitle, string[][] identityCandidates,
        int expectedCandidateIndex, bool requireNewTaskIntent)
    {
        if (expectedCandidateIndex < -1 ||
            (identityTitle == null && identityCandidates != null && identityCandidates.Length > 0) ||
            (identityTitle != null && (identityCandidates == null || identityCandidates.Length < 1 ||
                identityCandidates.Length > 64 || expectedCandidateIndex < 0 ||
                expectedCandidateIndex >= identityCandidates.Length))) return "validate";
        if (requireNewTaskIntent &&
            (identityTitle != null || (identityCandidates != null && identityCandidates.Length > 0)))
            return "new-task-intent-precondition";
        return "fresh-tree";
    }
}
'@
Add-Type -TypeDefinition $fixtureSource

$ordinaryNull = $null
$emptyCandidates = [System.String[][]]@()
$nullString = [System.Management.Automation.Language.NullString]::Value
$identityTitleForCom = $ordinaryNull
if ($null -eq $identityTitleForCom) { $identityTitleForCom = $nullString }
$payloadForCom = $ordinaryNull
if ($null -eq $payloadForCom) { $payloadForCom = $nullString }
$expectedControlNameForCom = $nullString

[pscustomobject]@{
  ordinaryNull = [OptionalStringBindingFixture]::Describe($ordinaryNull)
  emptyCandidatesNavigationStage = [OptionalStringBindingFixture]::NextStage($ordinaryNull, $emptyCandidates, -1, $false)
  emptyCandidatesNewTaskIntentStage = [OptionalStringBindingFixture]::NextStage($ordinaryNull, $emptyCandidates, -1, $true)
  clrNullIdentity = [OptionalStringBindingFixture]::Describe($identityTitleForCom)
  clrNullPayload = [OptionalStringBindingFixture]::Describe($payloadForCom)
  clrNullExpectedControlName = [OptionalStringBindingFixture]::Describe($expectedControlNameForCom)
  clrNullNavigationStage = [OptionalStringBindingFixture]::NextStage($identityTitleForCom, $emptyCandidates, -1, $false)
  clrNullNewTaskIntentStage = [OptionalStringBindingFixture]::NextStage($identityTitleForCom, $emptyCandidates, -1, $true)
} | ConvertTo-Json -Compress
