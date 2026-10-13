using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

public static partial class WorkBuddyWindowsUiaComProbe
{
    private const int ModelPopupAutomationIdPropertyId = 30011;
    private const int ModelPopupAriaRolePropertyId = 30101;
    private const int ModelPopupAriaPropertiesPropertyId = 30102;
    private const int ModelPopupControllerForPropertyId = 30104;
    private const int ModelPopupMaxNodes = 5000;
    private const int ModelPopupMaxRoots = 64;
    private const int ModelPopupMaxOptions = 100;
    private const int ModelPopupMaxControlsPerOption = 32;

    // IUIAutomationElementArray from the public UIAutomationClient.h SDK.
    // The existing probe already supplies IUIAutomationElement; this narrow
    // companion declaration adds only the collection interface needed by the
    // ControllerFor property.
    [ComImport, Guid("14314595-B4BC-4055-95F2-58F2E42C9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface WorkBuddyIUIAutomationElementArray
    {
        [PreserveSig] int get_Length(out int length);
        [PreserveSig] int GetElement(int index, out WorkBuddyIUIAutomationElement element);
    }
    [ComImport, Guid("B488300F-D015-4F19-9C29-BB595E3645EF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface WorkBuddyIUIAutomationScrollItemPattern {
        [PreserveSig] int ScrollIntoView();
    }

    public sealed class ModelPopupInspection
    {
        public bool complete { get; set; }
        public string reason { get; set; }
        public string selectorRuntimeIdHash { get; set; }
        public string selectorRegionHash { get; set; }
        public string popupRuntimeIdHash { get; set; }
        public string popupAutomationIdHash { get; set; }
        public int selectedCurrentModelCount { get; set; }
        public ModelPopupOption[] options { get; set; }
    }

    public sealed class ModelPopupOption
    {
        public string modelName { get; set; }
        public bool enabled { get; set; }
        public bool selected { get; set; }
        public string runtimeIdHash { get; set; }
        public string pathHash { get; set; }
        public string regionHash { get; set; }
    }

    // Private, closed evidence used by the native property reader and tests.
    // Raw AutomationIds and ARIA strings never leave this shape.
    internal sealed class ModelPopupSnapshotEvidence
    {
        internal bool complete;
        internal int expansionState;
        internal string selectorRuntimeIdHash;
        internal string selectorRegionHash;
        internal string composerRuntimeIdHash;
        internal string draftFingerprint;
        internal string currentModel;
        internal string selectorAriaProperties;
        internal bool controllerForValid;
        internal string[] controllerForRuntimeIdHashes;
        internal ModelPopupNodeEvidence[] nodes;
    }

    internal sealed class ModelPopupNodeEvidence
    {
        internal string path;
        internal int depth;
        internal int controlTypeId;
        internal string automationId;
        internal string ariaRole;
        internal string ariaProperties;
        internal string accessibleName;
        internal string runtimeIdHash;
        internal string regionHash;
        internal bool enabledKnown;
        internal bool enabled;
        internal bool offscreenKnown;
        internal bool offscreen;
        internal bool selectedKnown;
        internal bool selected;
    }

    private static ModelPopupInspection ModelPopupFailure(string reason,
        string selectorRuntimeIdHash, string selectorRegionHash, string popupRuntimeIdHash,
        string popupAutomationIdHash, int selectedCurrentModelCount)
    {
        return new ModelPopupInspection {
            complete = false,
            reason = reason,
            selectorRuntimeIdHash = PendingHashIsValid(selectorRuntimeIdHash) ? selectorRuntimeIdHash : String.Empty,
            selectorRegionHash = PendingHashIsValid(selectorRegionHash) ? selectorRegionHash : String.Empty,
            popupRuntimeIdHash = PendingHashIsValid(popupRuntimeIdHash) ? popupRuntimeIdHash : String.Empty,
            popupAutomationIdHash = PendingHashIsValid(popupAutomationIdHash) ? popupAutomationIdHash : String.Empty,
            selectedCurrentModelCount = Math.Max(0, Math.Min(ModelPopupMaxOptions, selectedCurrentModelCount)),
            options = new ModelPopupOption[0]
        };
    }

    private static bool ModelPopupHashIsValid(string value)
    {
        return PendingHashIsValid(value);
    }

    private static string ModelPopupBoundedString(object value, int maxLength)
    {
        string text = value as string;
        if (text == null || text.Length == 0 || text.Length > maxLength) return String.Empty;
        foreach (char character in text)
        {
            if (Char.IsControl(character) && character != '\r' && character != '\n' && character != '\t')
                return String.Empty;
        }
        return text.Trim();
    }

    private static bool ModelPopupReadBoolean(Node node, int propertyId, out bool value)
    {
        value = false;
        if (node == null || node.Element == null || !HelperBudgetReady()) return false;
        object raw;
        try { raw = Property(node.Element, propertyId); }
        catch { return false; }
        if (!(raw is bool)) return false;
        value = (bool)raw;
        return true;
    }

    private static string ModelPopupReadString(Node node, int propertyId, int maxLength)
    {
        if (node == null || node.Element == null || !HelperBudgetReady()) return String.Empty;
        try { return ModelPopupBoundedString(Property(node.Element, propertyId), maxLength); }
        catch { return String.Empty; }
    }

    private static string ModelPopupNormalizeAriaKey(string value)
    {
        string key = (value ?? String.Empty).Trim().ToLowerInvariant();
        if (key.StartsWith("aria-", StringComparison.Ordinal)) key = key.Substring(5);
        return key;
    }

    private static string[] ModelPopupAriaIdReferences(string ariaProperties, string wantedKey, out bool valid)
    {
        valid = true;
        if (String.IsNullOrEmpty(ariaProperties)) return new string[0];
        // UIA AriaProperties escapes delimiters with backslash. We do not
        // decode arbitrary provider strings; refuse escaped input rather
        // than split it into a different relationship.
        if (ariaProperties.Length > 4096 || ariaProperties.IndexOf('\\') >= 0)
        { valid = false; return new string[0]; }
        List<string> values = new List<string>();
        HashSet<string> seenKeys = new HashSet<string>(StringComparer.Ordinal);
        string[] entries = ariaProperties.Split(new char[] { ';', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (entries.Length > 64) { valid = false; return new string[0]; }
        foreach (string entry in entries)
        {
            int separator = entry.IndexOf('=');
            if (separator <= 0) { valid = false; return new string[0]; }
            string key = ModelPopupNormalizeAriaKey(entry.Substring(0, separator));
            string value = entry.Substring(separator + 1).Trim().Trim('"', '\'');
            if (key.Length == 0 || key.Length > 64 || value.Length > 1024) { valid = false; return new string[0]; }
            if (key != wantedKey) continue;
            if (!seenKeys.Add(key)) { valid = false; return new string[0]; }
            string[] references = value.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            if (references.Length > 16) { valid = false; return new string[0]; }
            foreach (string reference in references)
            {
                if (!ModelPopupAutomationIdIsValid(reference)) { valid = false; return new string[0]; }
                values.Add(reference);
            }
        }
        if (values.Distinct(StringComparer.Ordinal).Count() != values.Count) valid = false;
        return valid ? values.ToArray() : new string[0];
    }

    private static bool ModelPopupAriaBoolean(string ariaProperties, string wantedKey, out bool present, out bool value)
    {
        present = false;
        value = false;
        if (String.IsNullOrEmpty(ariaProperties)) return true;
        if (ariaProperties.Length > 4096 || ariaProperties.IndexOf('\\') >= 0) return false;
        string[] entries = ariaProperties.Split(new char[] { ';', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (entries.Length > 64) return false;
        foreach (string entry in entries)
        {
            int separator = entry.IndexOf('=');
            if (separator <= 0) return false;
            string key = ModelPopupNormalizeAriaKey(entry.Substring(0, separator));
            if (key != wantedKey) continue;
            if (present) return false;
            string text = entry.Substring(separator + 1).Trim().Trim('"', '\'');
            if (String.Equals(text, "true", StringComparison.OrdinalIgnoreCase)) value = true;
            else if (String.Equals(text, "false", StringComparison.OrdinalIgnoreCase)) value = false;
            else return false;
            present = true;
        }
        return true;
    }

    private static bool ModelPopupAutomationIdIsValid(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 256) return false;
        foreach (char character in value)
        {
            if (Char.IsControl(character)) return false;
        }
        return true;
    }

    private static bool ModelPopupTryReadControllerForRuntimeIdHashes(
        WorkBuddyIUIAutomationElement element, out string[] runtimeIdHashes)
    {
        runtimeIdHashes = new string[0];
        if (element == null || !HelperBudgetReady()) return false;
        object raw;
        try { raw = Property(element, ModelPopupControllerForPropertyId); }
        catch { return false; }
        if (raw == null) return true;
        WorkBuddyIUIAutomationElementArray elements = raw as WorkBuddyIUIAutomationElementArray;
        if (elements == null)
        {
            if (Marshal.IsComObject(raw))
            {
                try { Marshal.ReleaseComObject(raw); } catch { }
            }
            return false;
        }
        try
        {
            if (!HelperBudgetReady()) return false;
            int length;
            if (elements.get_Length(out length) < 0 || length < 0 || length > 16) return false;
            List<string> ids = new List<string>();
            for (int index = 0; index < length; index++)
            {
                if (!HelperBudgetReady()) return false;
                WorkBuddyIUIAutomationElement controlled = null;
                try
                {
                    if (elements.GetElement(index, out controlled) < 0 || controlled == null) return false;
                    string runtimeIdHash = RuntimeIdHash(controlled);
                    if (!ModelPopupHashIsValid(runtimeIdHash)) return false;
                    ids.Add(runtimeIdHash);
                }
                catch { return false; }
                finally
                {
                    // GetElement returns a distinct COM reference. Release
                    // that reference after hashing; the snapshot keeps its
                    // own element references alive.
                    if (controlled != null && Marshal.IsComObject(controlled))
                    {
                        try { Marshal.ReleaseComObject(controlled); } catch { }
                    }
                }
            }
            if (ids.Distinct(StringComparer.Ordinal).Count() != ids.Count) return false;
            runtimeIdHashes = ids.ToArray();
            return true;
        }
        finally
        {
            if (Marshal.IsComObject(elements))
            {
                try { Marshal.ReleaseComObject(elements); } catch { }
            }
        }
    }

    private static bool ModelPopupFrameMatches(ModelPopupSnapshotEvidence first, ModelPopupSnapshotEvidence second)
    {
        return first != null && second != null && first.complete && second.complete &&
            ModelPopupHashIsValid(first.selectorRuntimeIdHash) &&
            ModelPopupHashIsValid(first.selectorRegionHash) &&
            ModelPopupHashIsValid(first.composerRuntimeIdHash) &&
            ModelPopupHashIsValid(first.draftFingerprint) &&
            String.Equals(first.selectorRuntimeIdHash, second.selectorRuntimeIdHash, StringComparison.Ordinal) &&
            String.Equals(first.selectorRegionHash, second.selectorRegionHash, StringComparison.Ordinal) &&
            String.Equals(first.composerRuntimeIdHash, second.composerRuntimeIdHash, StringComparison.Ordinal) &&
            String.Equals(first.draftFingerprint, second.draftFingerprint, StringComparison.Ordinal) &&
            String.Equals(first.currentModel, second.currentModel, StringComparison.Ordinal);
    }

    private static bool ModelPopupIsUnder(string candidatePath, string rootPath)
    {
        return !String.IsNullOrEmpty(candidatePath) && !String.IsNullOrEmpty(rootPath) &&
            (String.Equals(candidatePath, rootPath, StringComparison.Ordinal) ||
             candidatePath.StartsWith(rootPath + "/", StringComparison.Ordinal));
    }

    private static bool ModelPopupIsListboxRoot(ModelPopupNodeEvidence node)
    {
        if (node == null) return false;
        return String.Equals(node.ariaRole, "listbox", StringComparison.OrdinalIgnoreCase) || node.controlTypeId == 50008;
    }

    private static bool ModelPopupTrySelected(ModelPopupNodeEvidence node, out bool selected)
    {
        selected = false;
        if (node == null) return false;
        bool ariaPresent, ariaValue;
        if (!ModelPopupAriaBoolean(node.ariaProperties, "selected", out ariaPresent, out ariaValue)) return false;
        if (node.selectedKnown && ariaPresent && node.selected != ariaValue) return false;
        if (node.selectedKnown)
        {
            selected = node.selected;
            return true;
        }
        if (!ariaPresent) return false;
        selected = ariaValue;
        return true;
    }

    private static ModelPopupInspection ProjectModelPopupFailure(string reason, ModelPopupSnapshotEvidence snapshot,
        string popupRuntimeIdHash, string popupAutomationIdHash, int selectedCount)
    {
        return ModelPopupFailure(reason,
            snapshot == null ? String.Empty : snapshot.selectorRuntimeIdHash,
            snapshot == null ? String.Empty : snapshot.selectorRegionHash,
            popupRuntimeIdHash, popupAutomationIdHash, selectedCount);
    }

    internal static ModelPopupInspection ProjectModelPopupEvidence(
        ModelPopupSnapshotEvidence before, ModelPopupSnapshotEvidence expanded, string currentModel)
    {
        if (before == null || expanded == null || !before.complete || !expanded.complete ||
            before.nodes == null || expanded.nodes == null || expanded.nodes.Length > ModelPopupMaxNodes)
            return ProjectModelPopupFailure("snapshot-incomplete", expanded, String.Empty, String.Empty, 0);
        if (!ModelPopupFrameMatches(before, expanded) || !IsSafeCatalogLabel(currentModel) ||
            !String.Equals(expanded.currentModel, currentModel, StringComparison.Ordinal))
            return ProjectModelPopupFailure("selector-context-unverified", expanded, String.Empty, String.Empty, 0);
        if (expanded.expansionState != 1)
            return ProjectModelPopupFailure("selector-not-expanded", expanded, String.Empty, String.Empty, 0);
        if (!expanded.controllerForValid || expanded.controllerForRuntimeIdHashes == null ||
            expanded.controllerForRuntimeIdHashes.Length > 16)
            return ProjectModelPopupFailure("controller-relationship-invalid", expanded, String.Empty, String.Empty, 0);

        bool controlsValid;
        string[] controlledIds = ModelPopupAriaIdReferences(expanded.selectorAriaProperties, "controls", out controlsValid);
        if (!controlsValid) return ProjectModelPopupFailure("aria-controls-invalid", expanded, String.Empty, String.Empty, 0);
        if (controlledIds.Length > 1)
            return ProjectModelPopupFailure("aria-controls-ambiguous", expanded, String.Empty, String.Empty, 0);

        List<ModelPopupNodeEvidence> nodes = expanded.nodes.ToList();
        if (nodes.Any(node => node == null || String.IsNullOrEmpty(node.path) || node.path.Length > 1024 ||
            node.depth < 0 || node.depth > 128 || node.automationId != null && node.automationId.Length > 256 ||
            node.ariaRole != null && node.ariaRole.Length > 64 || node.ariaProperties != null && node.ariaProperties.Length > 4096))
            return ProjectModelPopupFailure("popup-evidence-invalid", expanded, String.Empty, String.Empty, 0);

        HashSet<string> paths = new HashSet<string>(StringComparer.Ordinal);
        if (nodes.Any(node => !paths.Add(node.path)))
            return ProjectModelPopupFailure("popup-evidence-duplicate-path", expanded, String.Empty, String.Empty, 0);

        List<ModelPopupNodeEvidence> matchingRoots = new List<ModelPopupNodeEvidence>();
        foreach (ModelPopupNodeEvidence root in nodes)
        {
            if (!ModelPopupIsListboxRoot(root) || !ModelPopupAutomationIdIsValid(root.automationId) ||
                !ModelPopupHashIsValid(root.runtimeIdHash) || !ModelPopupHashIsValid(root.regionHash)) continue;
            bool controlsMatch = controlledIds.Contains(root.automationId, StringComparer.Ordinal);
            bool controllerMatch = expanded.controllerForRuntimeIdHashes.Contains(root.runtimeIdHash, StringComparer.Ordinal);
            if (!controlsMatch && !controllerMatch) continue;
            // If both native relationship surfaces are present, contradictory
            // values are not reconciled through model names or tree proximity.
            if (controlledIds.Length > 0 && expanded.controllerForRuntimeIdHashes.Length > 0 &&
                controlsMatch != controllerMatch) continue;
            matchingRoots.Add(root);
            if (matchingRoots.Count > ModelPopupMaxRoots)
                return ProjectModelPopupFailure("listbox-relationship-ambiguous", expanded, String.Empty, String.Empty, 0);
        }
        if (matchingRoots.Count != 1)
            return ProjectModelPopupFailure(matchingRoots.Count == 0 ? "listbox-relationship-unavailable" : "listbox-relationship-ambiguous",
                expanded, String.Empty, String.Empty, 0);

        ModelPopupNodeEvidence popup = matchingRoots[0];
        if (!popup.enabledKnown || !popup.enabled || !popup.offscreenKnown || popup.offscreen)
            return ProjectModelPopupFailure("listbox-not-visible", expanded, popup.runtimeIdHash, Hash(popup.automationId), 0);
        if (!String.Equals(popup.ariaRole, "listbox", StringComparison.OrdinalIgnoreCase) && popup.controlTypeId != 50008)
            return ProjectModelPopupFailure("listbox-role-unverified", expanded, popup.runtimeIdHash, Hash(popup.automationId), 0);

        List<ModelPopupOption> options = new List<ModelPopupOption>();
        HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
        HashSet<string> runtimeIds = new HashSet<string>(StringComparer.Ordinal);
        int selectedCount = 0;
        bool currentModelSelected = false;
        foreach (ModelPopupNodeEvidence option in nodes)
        {
            if (String.Equals(option.path, popup.path, StringComparison.Ordinal) ||
                !ModelPopupIsUnder(option.path, popup.path)) continue;
            bool roleIsOption = String.Equals(option.ariaRole, "option", StringComparison.OrdinalIgnoreCase);
            if (!roleIsOption && option.controlTypeId != 50007) continue;
            if (!roleIsOption)
                return ProjectModelPopupFailure("option-role-unverified", expanded, popup.runtimeIdHash, Hash(popup.automationId), selectedCount);
            if (option.depth <= popup.depth || option.depth > popup.depth + 8 ||
                !option.enabledKnown || !option.offscreenKnown ||
                !option.selectedKnown && String.IsNullOrEmpty(option.ariaProperties) ||
                !ModelPopupHashIsValid(option.runtimeIdHash) || !ModelPopupHashIsValid(option.regionHash) ||
                !String.Equals(option.regionHash, popup.regionHash, StringComparison.Ordinal) ||
                !IsSafeCatalogLabel(option.accessibleName))
                return ProjectModelPopupFailure("option-set-incomplete", expanded, popup.runtimeIdHash, Hash(popup.automationId), selectedCount);
            bool selected;
            if (!ModelPopupTrySelected(option, out selected) || !runtimeIds.Add(option.runtimeIdHash) ||
                !names.Add(option.accessibleName))
                return ProjectModelPopupFailure("option-set-ambiguous", expanded, popup.runtimeIdHash, Hash(popup.automationId), selectedCount);
            if (selected)
            {
                selectedCount++;
                if (String.Equals(option.accessibleName, currentModel, StringComparison.Ordinal)) currentModelSelected = true;
            }
            options.Add(new ModelPopupOption {
                modelName = option.accessibleName,
                enabled = option.enabled,
                selected = selected,
                runtimeIdHash = option.runtimeIdHash,
                pathHash = Hash(option.path),
                regionHash = option.regionHash
            });
            if (options.Count > ModelPopupMaxOptions)
                return ProjectModelPopupFailure("option-count-out-of-bounds", expanded, popup.runtimeIdHash, Hash(popup.automationId), selectedCount);
        }
        if (options.Count == 0)
            return ProjectModelPopupFailure("option-set-empty", expanded, popup.runtimeIdHash, Hash(popup.automationId), selectedCount);
        if (selectedCount != 1 || !currentModelSelected)
            return ProjectModelPopupFailure("selected-current-model-unverified", expanded,
                popup.runtimeIdHash, Hash(popup.automationId), selectedCount);

        return new ModelPopupInspection {
            complete = true,
            reason = null,
            selectorRuntimeIdHash = expanded.selectorRuntimeIdHash,
            selectorRegionHash = expanded.selectorRegionHash,
            popupRuntimeIdHash = popup.runtimeIdHash,
            popupAutomationIdHash = Hash(popup.automationId),
            selectedCurrentModelCount = selectedCount,
            options = options.ToArray()
        };
    }

    private static bool ModelPopupSnapshotIsComplete(Result snapshot)
    {
        return snapshot != null && snapshot.status != null && !snapshot.status.traversalTruncated &&
            snapshot.status.traversedNodes > 0 && snapshot.status.traversedNodes <= ModelPopupMaxNodes &&
            snapshot.AllNodeReferences != null && snapshot.AllNodeReferences.Length == snapshot.status.traversedNodes &&
            snapshot.NodeTypeByPath != null && snapshot.NodeTypeByPath.Count == snapshot.AllNodeReferences.Length &&
            snapshot.AllNodeReferences.All(node => node != null && node.Element != null && !String.IsNullOrEmpty(node.Path));
    }

    private static ModelPopupNodeEvidence ModelPopupReadNodeEvidence(Node node, int controlTypeId, string accessibleName)
    {
        bool enabled, offscreen, selected;
        bool enabledKnown = ModelPopupReadBoolean(node, EnabledPropertyId, out enabled);
        bool offscreenKnown = ModelPopupReadBoolean(node, OffscreenPropertyId, out offscreen);
        bool selectedKnown = ModelPopupReadBoolean(node, SelectedPropertyId, out selected);
        return new ModelPopupNodeEvidence {
            path = node.Path,
            depth = node.Depth,
            controlTypeId = controlTypeId,
            automationId = ModelPopupReadString(node, ModelPopupAutomationIdPropertyId, 256),
            ariaRole = ModelPopupReadString(node, ModelPopupAriaRolePropertyId, 64),
            ariaProperties = ModelPopupReadString(node, ModelPopupAriaPropertiesPropertyId, 4096),
            accessibleName = accessibleName,
            runtimeIdHash = RuntimeIdHash(node.Element),
            regionHash = Hash(String.IsNullOrEmpty(node.RegionPath) ? "root" : node.RegionPath),
            enabledKnown = enabledKnown,
            enabled = enabled,
            offscreenKnown = offscreenKnown,
            offscreen = offscreen,
            selectedKnown = selectedKnown,
            selected = selected
        };
    }

    internal static string ProjectModelPopupOptionName(string directName, string[] visibleTextNames)
    {
        if (IsSafeCatalogLabel(directName)) return directName.Trim();
        if (visibleTextNames == null || visibleTextNames.Length != 1 || !IsSafeCatalogLabel(visibleTextNames[0]))
            return String.Empty;
        return visibleTextNames[0].Trim();
    }

    private static string ModelPopupReadOptionName(Result snapshot, Node option)
    {
        string directName = ModelPopupReadString(option, NamePropertyId, 256);
        if (snapshot == null || snapshot.AllNodeReferences == null) return String.Empty;
        List<string> textNames = new List<string>();
        foreach (Node node in snapshot.AllNodeReferences)
        {
            if (!HelperBudgetReady()) return String.Empty;
            // The traversal's depth-zero root has already been released by
            // InspectInternal's finally block. Never probe its COM properties.
            if (node == null || node.Depth <= 0 || node.Element == null || !ModelPopupIsUnder(node.Path, option.Path) ||
                String.Equals(node.Path, option.Path, StringComparison.Ordinal) || node.Depth > option.Depth + 8) continue;
            int typeId;
            if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId) || typeId != 50020) continue;
            if (textNames.Count >= ModelPopupMaxControlsPerOption) return String.Empty;
            string name = ModelPopupReadString(node, NamePropertyId, 180);
            if (!String.IsNullOrEmpty(name)) textNames.Add(name);
        }
        // UIA Name includes image alt, label, badges and cost. The native
        // option's first Text child is the actual model label. Offscreen
        // options are still present in the same controlled listbox.
        return textNames.Count > 0 ? (IsSafeCatalogLabel(textNames[0]) ? textNames[0] : String.Empty)
            : (IsSafeCatalogLabel(directName) ? directName : String.Empty);
    }

    private static ModelPopupSnapshotEvidence ModelPopupReadSnapshotEvidence(Result snapshot, bool readPopup)
    {
        if (!ModelPopupSnapshotIsComplete(snapshot) || !HelperBudgetReady()) return null;
        ControlSummary selector, composer;
        Node selectorNode, composerNode;
        int expansionState;
        if (!TryGetModelFrame(snapshot, out selector, out selectorNode, out composer, out composerNode, out expansionState)) return null;
        if (selectorNode == null || composerNode == null ||
            (readPopup && expansionState != 1) || (!readPopup && expansionState != 0 && expansionState != 1)) return null;

        string currentModel = NormalizeModelName(selector.accessibleName);
        if (!IsSafeCatalogLabel(currentModel)) return null;
        string selectorAriaProperties = readPopup
            ? ModelPopupReadString(selectorNode, ModelPopupAriaPropertiesPropertyId, 4096)
            : String.Empty;
        string[] controllerRuntimeIdHashes = new string[0];
        bool controllerForValid = !readPopup || ModelPopupTryReadControllerForRuntimeIdHashes(
            selectorNode.Element, out controllerRuntimeIdHashes);
        if (!controllerForValid) return null;
        List<ModelPopupNodeEvidence> evidence = new List<ModelPopupNodeEvidence>();
        if (readPopup)
        {
            bool controlsValid;
            string[] controlledIds = ModelPopupAriaIdReferences(selectorAriaProperties, "controls", out controlsValid);
            if (!controlsValid) return null;
            List<Node> matchingRoots = new List<Node>();
            foreach (Node node in snapshot.AllNodeReferences)
            {
                if (!HelperBudgetReady()) return null;
                // The depth-zero traversal root is released before the
                // Result is returned; only descendant nodes are readable.
                if (node == null || node.Depth <= 0 || node.Element == null) continue;
                int typeId;
                if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId)) return null;
                if (typeId != 50008 && typeId != 50033 && typeId != 50026 && typeId != 50025) continue;
                string role = ModelPopupReadString(node, ModelPopupAriaRolePropertyId, 64);
                if (!String.Equals(role, "listbox", StringComparison.OrdinalIgnoreCase) && typeId != 50008) continue;
                string automationId = ModelPopupReadString(node, ModelPopupAutomationIdPropertyId, 256);
                if (!ModelPopupAutomationIdIsValid(automationId)) continue;
                bool controlsMatch = controlledIds.Contains(automationId, StringComparer.Ordinal);
                string runtimeIdHash = RuntimeIdHash(node.Element);
                bool controllerMatch = controllerRuntimeIdHashes.Contains(runtimeIdHash, StringComparer.Ordinal);
                if (!controlsMatch && !controllerMatch) continue;
                if (controlledIds.Length > 0 && controllerRuntimeIdHashes.Length > 0 && controlsMatch != controllerMatch) continue;
                matchingRoots.Add(node);
                if (matchingRoots.Count > ModelPopupMaxRoots) return null;
            }
            if (matchingRoots.Count == 1)
            {
                Node root = matchingRoots[0];
                int rootType;
                if (!snapshot.NodeTypeByPath.TryGetValue(root.Path, out rootType)) return null;
                evidence.Add(ModelPopupReadNodeEvidence(root, rootType, String.Empty));
                int optionNodes = 0;
                foreach (Node node in snapshot.AllNodeReferences)
                {
                    if (!HelperBudgetReady()) return null;
                    if (!ModelPopupIsUnder(node.Path, root.Path) || String.Equals(node.Path, root.Path, StringComparison.Ordinal) ||
                        node.Depth > root.Depth + 8) continue;
                    int typeId;
                    if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out typeId)) return null;
                    string role = ModelPopupReadString(node, ModelPopupAriaRolePropertyId, 64);
                    if (!String.Equals(role, "option", StringComparison.OrdinalIgnoreCase) && typeId != 50007) continue;
                    string name = ModelPopupReadOptionName(snapshot, node);
                    evidence.Add(ModelPopupReadNodeEvidence(node, typeId, name));
                    optionNodes++;
                    if (optionNodes > ModelPopupMaxOptions) return null;
                }
            }
            else
            {
                // Include matched candidate roots (if any) to let the pure
                // projection return the precise unavailable/ambiguous reason.
                foreach (Node node in matchingRoots)
                {
                    int rootType;
                    if (!snapshot.NodeTypeByPath.TryGetValue(node.Path, out rootType)) return null;
                    evidence.Add(ModelPopupReadNodeEvidence(node, rootType, String.Empty));
                }
            }
        }

        return new ModelPopupSnapshotEvidence {
            complete = true,
            expansionState = expansionState,
            selectorRuntimeIdHash = selector.runtimeIdHash,
            selectorRegionHash = selector.regionHash,
            composerRuntimeIdHash = composer.runtimeIdHash,
            draftFingerprint = composer.draftFingerprint,
            currentModel = currentModel,
            selectorAriaProperties = selectorAriaProperties,
            controllerForValid = controllerForValid,
            controllerForRuntimeIdHashes = controllerRuntimeIdHashes,
            nodes = evidence.ToArray()
        };
    }

    // Read-only projection for a current native model popup. The snapshots
    // must retain the same selector, composer and draft identity; listbox
    // association is proven by UIA ARIA/ControllerFor properties, never by
    // label similarity or a popup merely appearing nearby in the tree.
    public static ModelPopupInspection InspectModelPopup(Result before, Result expanded, string currentModel)
    {
        ModelPopupSnapshotEvidence expandedEvidence = ModelPopupReadSnapshotEvidence(expanded, true);
        ModelPopupSnapshotEvidence beforeEvidence = Object.ReferenceEquals(before, expanded)
            ? expandedEvidence : ModelPopupReadSnapshotEvidence(before, false);
        if (beforeEvidence == null || expandedEvidence == null)
            return ModelPopupFailure("snapshot-or-selector-incomplete", String.Empty, String.Empty,
                String.Empty, String.Empty, 0);
        return ProjectModelPopupEvidence(beforeEvidence, expandedEvidence, currentModel);
    }

    public sealed class ModelSelectionReceipt
    {
        public bool attempted { get; set; }
        public bool submitted { get; set; }
        public bool verified { get; set; }
        public string currentModel { get; set; }
        public string stage { get; set; }
        public string reason { get; set; }
        public ActionResult[] patternReceipts { get; set; }
    }

    private static Result ReadModelSelectionContext(IntPtr hwnd, string title, string[][] candidates)
    {
        return title == null ? InspectSemantic(hwnd, 5000, 2200) : InspectSemanticIdentity(hwnd, 5000, 2200, title, candidates);
    }

    private static bool ModelSelectionContextValid(Result snapshot, string title, string[][] candidates, int index, string[] titles)
    {
        if (!HasCompleteSnapshotStatus(snapshot)) return false;
        return title != null ? IsFreshIdentitySnapshot(snapshot, candidates == null ? 0 : candidates.Length, index)
            : titles != null && AnalyzeNewTaskPage(snapshot, titles).verified;
    }

    // Options are selected only from the popup controlled by this exact
    // composer. This never selects a similarly named sidebar/project row.
    public static ModelSelectionReceipt SelectNativeModel(IntPtr hwnd, int pid, string exe, string requestedModel,
        string title, string[][] candidates, int index, string[] titles)
    {
        ModelSelectionReceipt r = new ModelSelectionReceipt { stage = "validate", reason = "model-unverified", patternReceipts = new ActionResult[0] };
        List<ActionResult> receipts = new List<ActionResult>();
        if (!IsSafeCatalogLabel(requestedModel) || !HelperBudgetReady() || !IsExactPendingTarget(hwnd, pid, exe)) return r;
        Result before = ReadModelSelectionContext(hwnd, title, candidates);
        ControlSummary selector, composer; Node selectorNode, composerNode; int expansion;
        if (!ModelSelectionContextValid(before, title, candidates, index, titles) ||
            !TryGetModelFrame(before, out selector, out selectorNode, out composer, out composerNode, out expansion) ||
            composer.draftState != "empty" || composer.draftFingerprint != "e3b0c44298fc1c14") { r.stage = "draft-precondition"; return r; }
        string current = NormalizeModelName(selector.accessibleName); r.currentModel = current;
        if (requestedModel == current) { r.verified = true; r.stage = "confirmed"; r.reason = null; return r; }
        if (expansion == 0) {
            ActionResult expanded = ExecuteSemanticAction(hwnd, pid, "expand", selector.runtimeIdHash, selector.regionHash,
                "model-selector", composer.draftFingerprint, null, null, null, -1, selector.accessibleName);
            receipts.Add(expanded); r.patternReceipts = receipts.ToArray();
            if (!expanded.submitted) { r.attempted = expanded.attempted; r.stage = "expand"; return r; }
            if (HelperBudgetReady()) System.Threading.Thread.Sleep(200);
        }
        Result popupSnapshot = ReadModelSelectionContext(hwnd, title, candidates);
        if (!ModelSelectionContextValid(popupSnapshot, title, candidates, index, titles)) { r.stage = "conversation-identity"; return r; }
        ModelPopupInspection popup = InspectModelPopup(before, popupSnapshot, current);
        if (!popup.complete) { r.stage = "popup"; r.reason = popup.reason; return r; }
        ModelPopupOption[] options = popup.options.Where(o => o.modelName == requestedModel && o.enabled).ToArray();
        if (options.Length != 1) { r.stage = "model-not-available"; return r; }
        ModelPopupOption option = options[0];
        Node[] nodes = popupSnapshot.AllNodeReferences.Where(n => n.Depth > 0 && n.Element != null &&
            Hash(n.Path) == option.pathHash && RuntimeIdHash(n.Element) == option.runtimeIdHash).ToArray();
        if (nodes.Length != 1 || !BoolProperty(nodes[0].Element, EnabledPropertyId) ||
            BoolProperty(nodes[0].Element, IsPasswordPropertyId) || !IsExactPendingTarget(hwnd, pid, exe) || !HelperBudgetReady()) { r.stage = "option-state"; return r; }
        if (BoolProperty(nodes[0].Element, OffscreenPropertyId)) {
            object scrollObject = null;
            try {
                int hr = nodes[0].Element.GetCurrentPattern(10017, out scrollObject);
                WorkBuddyIUIAutomationScrollItemPattern scroll = scrollObject as WorkBuddyIUIAutomationScrollItemPattern;
                if (hr < 0 || scroll == null) { r.stage = "scroll-pattern-unavailable"; return r; }
                if (!HelperBudgetReady() || !IsExactPendingTarget(hwnd, pid, exe)) return r;
                ActionResult scrollReceipt = new ActionResult { operation = "scroll-into-view", attempted = true,
                    targetContextVerified = true, foregroundVerified = IsTargetForeground(hwnd), matchingControls = 1, stage = "pattern-call" };
                scrollReceipt.hresult = scroll.ScrollIntoView(); scrollReceipt.submitted = scrollReceipt.hresult >= 0;
                if (scrollReceipt.submitted) scrollReceipt.stage = "submitted";
                receipts.Add(scrollReceipt); r.patternReceipts = receipts.ToArray();
                if (!scrollReceipt.submitted) { r.stage = "scroll"; return r; }
            } finally { if (scrollObject != null && Marshal.IsComObject(scrollObject)) { try { Marshal.ReleaseComObject(scrollObject); } catch { } } }
            if (HelperBudgetReady()) System.Threading.Thread.Sleep(150);
            Result scrolled = ReadModelSelectionContext(hwnd, title, candidates);
            if (!ModelSelectionContextValid(scrolled, title, candidates, index, titles)) { r.stage = "conversation-identity"; return r; }
            ModelPopupInspection scrolledPopup = InspectModelPopup(before, scrolled, current);
            if (!scrolledPopup.complete) { r.stage = "scroll-postcondition"; return r; }
            ModelPopupOption[] freshOptions = scrolledPopup.options.Where(o => o.modelName == requestedModel && o.enabled && o.runtimeIdHash == option.runtimeIdHash).ToArray();
            if (freshOptions.Length != 1) { r.stage = "scroll-postcondition"; return r; }
            option = freshOptions[0];
            nodes = scrolled.AllNodeReferences.Where(n => n.Depth > 0 && n.Element != null && Hash(n.Path) == option.pathHash &&
                RuntimeIdHash(n.Element) == option.runtimeIdHash && !BoolProperty(n.Element, OffscreenPropertyId)).ToArray();
            if (nodes.Length != 1) { r.stage = "scroll-postcondition"; return r; }
        }
        object pattern = null;
        try {
            int hr = nodes[0].Element.GetCurrentPattern(SelectionItemPatternId, out pattern);
            WorkBuddyIUIAutomationSelectionItemPattern selection = pattern as WorkBuddyIUIAutomationSelectionItemPattern;
            if (hr >= 0 && selection != null) {
                r.stage = "selection"; r.attempted = true; r.submitted = selection.Select() >= 0;
            } else {
                if (pattern != null && Marshal.IsComObject(pattern)) Marshal.ReleaseComObject(pattern);
                pattern = null;
                hr = nodes[0].Element.GetCurrentPattern(InvokePatternId, out pattern);
                WorkBuddyIUIAutomationInvokePattern invoke = pattern as WorkBuddyIUIAutomationInvokePattern;
                if (hr < 0 || invoke == null) { r.stage = "option-pattern-unavailable"; return r; }
                if (!IsExactPendingTarget(hwnd, pid, exe) || !HelperBudgetReady()) return r;
                r.stage = "invoke"; r.attempted = true; r.submitted = invoke.Invoke() >= 0;
            }
        } catch { r.reason = "selection-outcome-unknown"; return r; }
        finally { if (pattern != null && Marshal.IsComObject(pattern)) { try { Marshal.ReleaseComObject(pattern); } catch { } } }
        if (!r.submitted) { r.reason = "selection-outcome-unknown"; return r; }
        if (HelperBudgetReady()) System.Threading.Thread.Sleep(150);
        Result after = ReadModelSelectionContext(hwnd, title, candidates);
        ControlSummary finalSelector, finalComposer; Node finalSelectorNode, finalComposerNode; int finalExpansion;
        if (!ModelSelectionContextValid(after, title, candidates, index, titles) ||
            !TryGetModelFrame(after, out finalSelector, out finalSelectorNode, out finalComposer, out finalComposerNode, out finalExpansion) ||
            finalComposer.draftFingerprint != composer.draftFingerprint || NormalizeModelName(finalSelector.accessibleName) != requestedModel) {
            r.reason = "model-change-unconfirmed"; return r;
        }
        r.currentModel = requestedModel;
        if (finalExpansion == 1 && HelperBudgetReady()) {
            ActionResult collapsed = ExecuteSemanticAction(hwnd, pid, "collapse", finalSelector.runtimeIdHash, finalSelector.regionHash,
                "model-selector", finalComposer.draftFingerprint, null, null, null, -1, finalSelector.accessibleName);
            receipts.Add(collapsed); r.patternReceipts = receipts.ToArray();
            if (!collapsed.submitted) { r.reason = "popup-close-unconfirmed"; return r; }
            Result closed = ReadModelSelectionContext(hwnd, title, candidates);
            if (!ModelSelectionContextValid(closed, title, candidates, index, titles) ||
                !TryGetModelFrame(closed, out finalSelector, out finalSelectorNode, out finalComposer, out finalComposerNode, out finalExpansion) ||
                finalExpansion != 0 || finalComposer.draftFingerprint != composer.draftFingerprint || NormalizeModelName(finalSelector.accessibleName) != requestedModel) {
                r.reason = "popup-close-unconfirmed"; return r;
            }
        }
        r.verified = true; r.stage = "confirmed"; r.reason = null; return r;
    }
}
