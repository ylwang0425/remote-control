param(
  [Parameter(Mandatory=$true)]
  [string] $ComSourcePath,
  [Parameter(Mandatory=$true)]
  [string] $PendingSourcePath
)

$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $ComSourcePath
Add-Type -Path @($ComSourcePath, $PendingSourcePath,
  (Join-Path $nativeRoot 'model-popup.cs'), (Join-Path $nativeRoot 'pending-actions.cs'), (Join-Path $nativeRoot 'native-input.cs'))

$helper = @{ processId=900; windowsSessionId=1; is64BitOperatingSystem=$true; is64BitProcess=$true; isWow64Process=$false
  integrityLevel='medium'; integrityRid=8192; queryHresult=0; errorStage='' }
$targetContext = @{ processId=36728; windowsSessionId=1; is64BitOperatingSystem=$true; is64BitProcess=$true; isWow64Process=$false
  integrityLevel='medium'; integrityRid=8192; queryHresult=0; errorStage='' }
$processContext = @{ helper=$helper; target=$targetContext; sameWindowsSession=$true; sameBitness=$true; sameIntegrityLevel=$true }
$target = @{ processId=36728; handle='2623190'; mainWindow=$true; visible=$true; enabled=$true; minimized=$false
  isForeground=$false; foregroundHandle='1000' }
$chinesePlaceholder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5LuK5aSp5biu5L2g5YGa5Lqb5LuA5LmI77yfQCDmt7vliqDkuIrkuIvmlofvvIwv6LCD55So5oqA6IO95LiO5oyH5Luk'))
$compactChinesePlaceholder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5LuK5aSp5biu5L2g5YGa5Lqb5LuA5LmI77yfQOa3u+WKoOS4iuS4i+aWh++8jC/osIPnlKjmioDog73kuI7mjIfku6Q='))
$englishPlaceholder = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('V2hhdCBjYW4gSSBoZWxwIHlvdSB3aXRoPw=='))

$emptyMenu = New-Object WorkBuddyWindowsUiaComProbe+ModelMenuDiagnostic
$emptyMenu.association = 'unavailable'; $emptyMenu.newVisiblePopupRootCount = 0
$emptyMenu.selectedCurrentModelCount = 0; $emptyMenu.controls = [WorkBuddyWindowsUiaComProbe+ModelMenuControl[]]@()
$observedMenu = New-Object WorkBuddyWindowsUiaComProbe+ModelMenuDiagnostic
$observedMenu.association = 'unique-new-popup-selected-current-model'; $observedMenu.newVisiblePopupRootCount = 1
$observedMenu.selectedCurrentModelCount = 1
$menuRoot = New-Object WorkBuddyWindowsUiaComProbe+ModelMenuControl
$menuRoot.depthWithinPopup = 0; $menuRoot.controlType = 'ControlType.List'; $menuRoot.controlTypeId = 50008
$menuRoot.accessibleName = 'Models'; $menuRoot.enabled = $true; $menuRoot.offscreen = $false
$menuRoot.selected = $false; $menuRoot.passwordProtected = $false; $menuRoot.patterns = [string[]]@()
$menuRoot.pathHash = 'aaaaaaaaaaaaaaaa'; $menuRoot.runtimeIdHash = 'bbbbbbbbbbbbbbbb'; $menuRoot.regionHash = 'cccccccccccccccc'
$menuOption = New-Object WorkBuddyWindowsUiaComProbe+ModelMenuControl
$menuOption.depthWithinPopup = 1; $menuOption.controlType = 'ControlType.ListItem'; $menuOption.controlTypeId = 50007
$menuOption.accessibleName = 'Kimi-K3'; $menuOption.enabled = $true; $menuOption.offscreen = $false
$menuOption.selected = $true; $menuOption.passwordProtected = $false; $menuOption.patterns = [string[]]@('selectionItem')
$menuOption.pathHash = 'dddddddddddddddd'; $menuOption.runtimeIdHash = 'eeeeeeeeeeeeeeee'; $menuOption.regionHash = 'cccccccccccccccc'
$observedMenu.controls = [WorkBuddyWindowsUiaComProbe+ModelMenuControl[]]@($menuRoot, $menuOption)

$blocked = New-Object WorkBuddyWindowsUiaComProbe+ModelCatalogResult
$blocked.outcome = 'blocked'
$blocked.reason = 'composer-or-model-selector-not-unique'
$blocked.targetContextVerified = $true
$blocked.currentModel = ''
$blocked.models = [string[]]@()
$blocked.initialDraftFingerprint = ''
$blocked.finalDraftFingerprint = ''
$blocked.composerVerified = $false
$blocked.initiallyExpanded = $false
$blocked.finallyExpanded = $false
$blocked.modelMenu = $emptyMenu
$blocked.patternReceipts = [WorkBuddyWindowsUiaComProbe+ActionResult[]]@()

$expand = New-Object WorkBuddyWindowsUiaComProbe+ActionResult
$expand.operation = 'expand'; $expand.attempted = $true; $expand.submitted = $true
$expand.targetContextVerified = $true; $expand.foregroundVerified = $false; $expand.hresult = 0
$expand.stage = 'submitted'; $expand.matchingControls = 1
$collapse = New-Object WorkBuddyWindowsUiaComProbe+ActionResult
$collapse.operation = 'collapse'; $collapse.attempted = $true; $collapse.submitted = $true
$collapse.targetContextVerified = $true; $collapse.foregroundVerified = $false; $collapse.hresult = 0
$collapse.stage = 'submitted'; $collapse.matchingControls = 1
$confirmed = New-Object WorkBuddyWindowsUiaComProbe+ModelCatalogResult
$confirmed.outcome = 'confirmed'; $confirmed.reason = $null; $confirmed.targetContextVerified = $true
$confirmed.currentModel = 'Kimi-K3'; $confirmed.models = [string[]]@('Kimi-K3', 'Deepseek-V4.1-Flash')
$confirmed.initialDraftFingerprint = 'e3b0c44298fc1c14'; $confirmed.finalDraftFingerprint = 'e3b0c44298fc1c14'
$confirmed.composerVerified = $true; $confirmed.initiallyExpanded = $false; $confirmed.finallyExpanded = $false
$confirmed.modelMenu = $observedMenu
$confirmed.patternReceipts = [WorkBuddyWindowsUiaComProbe+ActionResult[]]@($expand, $collapse)
$restoredBlocked = New-Object WorkBuddyWindowsUiaComProbe+ModelCatalogResult
$restoredBlocked.outcome = 'blocked'; $restoredBlocked.reason = 'native-model-options-unavailable'
$restoredBlocked.targetContextVerified = $true; $restoredBlocked.currentModel = 'Kimi-K3'
$restoredBlocked.models = [string[]]@(); $restoredBlocked.initialDraftFingerprint = 'e3b0c44298fc1c14'
$restoredBlocked.finalDraftFingerprint = 'e3b0c44298fc1c14'; $restoredBlocked.composerVerified = $true
$restoredBlocked.initiallyExpanded = $false; $restoredBlocked.finallyExpanded = $false
$restoredBlocked.modelMenu = $emptyMenu
$restoredBlocked.patternReceipts = [WorkBuddyWindowsUiaComProbe+ActionResult[]]@($expand, $collapse)

function Convert-ModelCatalogFixture($catalog) {
  $menu = $catalog.modelMenu
  return @{ currentModel=[string]$catalog.currentModel; models=@($catalog.models)
    targetContextVerified=[bool]$catalog.targetContextVerified
    initialDraftFingerprint=[string]$catalog.initialDraftFingerprint; finalDraftFingerprint=[string]$catalog.finalDraftFingerprint
    composerVerified=[bool]$catalog.composerVerified; initiallyExpanded=[bool]$catalog.initiallyExpanded
    finallyExpanded=[bool]$catalog.finallyExpanded
    modelMenu=@{ association=[string]$menu.association; newVisiblePopupRootCount=[int]$menu.newVisiblePopupRootCount
      selectedCurrentModelCount=[int]$menu.selectedCurrentModelCount
      controls=@($menu.controls | ForEach-Object { @{ depthWithinPopup=[int]$_.depthWithinPopup
        controlType=[string]$_.controlType; controlTypeId=[int]$_.controlTypeId
        accessibleName=[string]$_.accessibleName; enabled=[bool]$_.enabled; offscreen=[bool]$_.offscreen
        selected=[bool]$_.selected; passwordProtected=[bool]$_.passwordProtected; patterns=@($_.patterns)
        pathHash=[string]$_.pathHash; runtimeIdHash=[string]$_.runtimeIdHash; regionHash=[string]$_.regionHash } }) }
    patternReceipts=@($catalog.patternReceipts) }
}

function New-HomeComposerAncestorChain([switch]$MissingRouteClass) {
  $document = New-Object WorkBuddyWindowsUiaComProbe+NewTaskPageAncestor
  $document.depth=1; $document.controlTypeId=50030; $document.accessibleName=''; $document.automationId='RootWebArea'
  $document.className=''; $document.ariaRole='document'; $document.pathHash='1000000000000001'
  $document.runtimeIdHash='2000000000000001'; $document.regionHash='1122334455667788'
  $page = New-Object WorkBuddyWindowsUiaComProbe+NewTaskPageAncestor
  $page.depth=2; $page.controlTypeId=50033; $page.accessibleName=''; $page.automationId=''
  $page.className='wb-home-page'; $page.ariaRole='pane'; $page.pathHash='1000000000000002'
  $page.runtimeIdHash='2000000000000002'; $page.regionHash=''
  $composer = New-Object WorkBuddyWindowsUiaComProbe+NewTaskPageAncestor
  $composer.depth=3; $composer.controlTypeId=50033; $composer.accessibleName=''; $composer.automationId=''
  $composer.className='wb-home-composer cb-font-size-capped'; $composer.ariaRole='pane'; $composer.pathHash='1000000000000003'
  $composer.runtimeIdHash='2000000000000003'; $composer.regionHash=''
  $route = New-Object WorkBuddyWindowsUiaComProbe+NewTaskPageAncestor
  $route.depth=4; $route.controlTypeId=50033; $route.accessibleName=''; $route.automationId=''
  $route.className='wb-home-route__input-wrap'
  if ($MissingRouteClass) { $route.className='cr-input-container' }
  $route.ariaRole='pane'; $route.pathHash='1000000000000004'; $route.runtimeIdHash='2000000000000004'; $route.regionHash=''
  $edit = New-Object WorkBuddyWindowsUiaComProbe+NewTaskPageAncestor
  $edit.depth=5; $edit.controlTypeId=50004; $edit.accessibleName=''; $edit.automationId=''
  $edit.className='_editable_1198_1'; $edit.ariaRole='textbox'; $edit.pathHash='1000000000000005'
  $edit.runtimeIdHash='2000000000000005'; $edit.regionHash=''
  return [WorkBuddyWindowsUiaComProbe+NewTaskPageAncestor[]]@($document,$page,$composer,$route,$edit)
}

@{
  draftFingerprints=@{
    empty=[WorkBuddyWindowsUiaComProbe]::ComposerDraftFingerprint('', $true)
    chinesePlaceholderSendDisabled=[WorkBuddyWindowsUiaComProbe]::ComposerDraftFingerprint($chinesePlaceholder, $true)
    compactChinesePlaceholderSendDisabled=[WorkBuddyWindowsUiaComProbe]::ComposerDraftFingerprint($compactChinesePlaceholder, $true)
    englishPlaceholderSendDisabled=[WorkBuddyWindowsUiaComProbe]::ComposerDraftFingerprint($englishPlaceholder, $true)
    chinesePlaceholderSendEnabled=[WorkBuddyWindowsUiaComProbe]::ComposerDraftFingerprint($chinesePlaceholder, $false)
    userText=[WorkBuddyWindowsUiaComProbe]::ComposerDraftFingerprint('retain this draft', $true)
  }
  newTaskPageProofs=@{
    positive=[WorkBuddyWindowsUiaComProbe]::BuildNewTaskPageProof($true, 1, 0, 0, 0, 0, '1122334455667788', (New-HomeComposerAncestorChain))
    selectedConversation=[WorkBuddyWindowsUiaComProbe]::BuildNewTaskPageProof($true, 1, 1, 0, 0, 0, '1122334455667788', (New-HomeComposerAncestorChain))
    matchingHeader=[WorkBuddyWindowsUiaComProbe]::BuildNewTaskPageProof($true, 1, 0, 1, 0, 0, '1122334455667788', (New-HomeComposerAncestorChain))
    missingHomeClass=[WorkBuddyWindowsUiaComProbe]::BuildNewTaskPageProof($true, 1, 0, 0, 0, 0, '1122334455667788', (New-HomeComposerAncestorChain -MissingRouteClass))
    truncated=[WorkBuddyWindowsUiaComProbe]::BuildNewTaskPageProof($false, 1, 0, 0, 0, 0, '1122334455667788', (New-HomeComposerAncestorChain))
  }
  nonChatNavigation=@{
    skills=[WorkBuddyWindowsUiaComProbe]::ClassifyGlobalNonChatPageForFixture(@('专家·技能·连接器'))
    selectedSubsection=[WorkBuddyWindowsUiaComProbe]::ClassifyGlobalNonChatPageForFixture(@('技能','Skills'))
    projects=[WorkBuddyWindowsUiaComProbe]::ClassifyGlobalNonChatPageForFixture(@('项目'))
    unknown=[WorkBuddyWindowsUiaComProbe]::ClassifyGlobalNonChatPageForFixture(@('会话'))
    mixed=[WorkBuddyWindowsUiaComProbe]::ClassifyGlobalNonChatPageForFixture(@('技能','项目'))
    noSelection=[WorkBuddyWindowsUiaComProbe]::ClassifyGlobalNonChatPageForFixture(@())
  }
  blocked=@{ protocol='workbuddy-native-uia-v1'; operation='native-model-catalog'; readOnly=$false; outcome=$blocked.outcome
    reason=$blocked.reason; inputDesktopKind='default'; targetContextVerified=$blocked.targetContextVerified
    target=$target; processContext=$processContext; catalog=(Convert-ModelCatalogFixture $blocked) }
  confirmed=@{ protocol='workbuddy-native-uia-v1'; operation='native-model-catalog'; readOnly=$false; outcome=$confirmed.outcome
    reason=$confirmed.reason; inputDesktopKind='default'; targetContextVerified=$confirmed.targetContextVerified
    target=$target; processContext=$processContext; catalog=(Convert-ModelCatalogFixture $confirmed) }
  restoredBlocked=@{ protocol='workbuddy-native-uia-v1'; operation='native-model-catalog'; readOnly=$false; outcome=$restoredBlocked.outcome
    reason=$restoredBlocked.reason; inputDesktopKind='default'; targetContextVerified=$restoredBlocked.targetContextVerified
    target=$target; processContext=$processContext; catalog=(Convert-ModelCatalogFixture $restoredBlocked) }
} | ConvertTo-Json -Depth 8 -Compress
