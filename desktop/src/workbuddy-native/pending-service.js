'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { BridgeError } = require('../errors');
const { analyzeNativeHistory } = require('./history-state');
const { WorkBuddyUiaPendingController, WorkBuddyUiaPendingControllerError, fingerprintHistoryAnalysis } = require('./uia-pending-controller');

function bridgePendingError(error) {
  if (!(error instanceof WorkBuddyUiaPendingControllerError)) return error;
  return new BridgeError(error.code === 'stale_request' ? 'not_capable' : error.code,
    error.code === 'stale_request' ? 'WorkBuddy request changed or was already answered; refresh this conversation' : error.message);
}

/** Compose actual archive records and current desktop evidence. UI receipts
 * remain submitted until a corresponding native tool result is persisted. */
class WorkBuddyPendingService {
  constructor({ load, readContext, execute, executablePath }) {
    this.load = load; this.readContext = readContext; this.execute = execute; this.executablePath = executablePath;
    this.controller = new WorkBuddyUiaPendingController({ ttlMs: 120000 });
    this.epoch = crypto.randomUUID(); this.sequence = 0; this.retired = false;
  }

  async observation(sessionId, hooks) {
    if (this.retired) throw new BridgeError('not_capable', 'WorkBuddy native control is closed');
    hooks?.checkActive?.();
    const source = this.load(sessionId);
    if (typeof source.cwd !== 'string' || !path.win32.isAbsolute(source.cwd)) throw new BridgeError('not_capable', 'WorkBuddy did not report an absolute native workspace');
    const cwd = path.win32.normalize(source.cwd);
    const analysis = analyzeNativeHistory(source.records, { sessionId, cwd, historyTruncated: source.historyTruncated });
    const context = await this.readContext(sessionId, hooks, analysis);
    hooks?.checkActive?.();
    const identityProof = { sessionId, expectedCandidateIndex: context.identityProof.expectedCandidateIndex,
      candidateCount: context.identityProof.candidateCount, matchedCandidateIndex: context.identityProof.matchedCandidateIndex,
      conversationHeaderMatches: context.identityProof.conversationHeaderMatches, historyFingerprint: fingerprintHistoryAnalysis(analysis) };
    const pendingForms = { ...context.pendingForms, sessionId, identityProof };
    return { input: { sessionId, epoch: this.epoch, sequence: ++this.sequence, cwd,
      historyAnalysis: analysis, pendingForms }, source, context };
  }

  async read(sessionId, hooks) {
    const observation = await this.observation(sessionId, hooks);
    let pending;
    try { pending = this.controller.observe(observation.input); } catch (error) { throw bridgePendingError(error); }
    const status = pending.pendingApprovals.length || pending.pendingQuestions.length || observation.context.stopState?.control ? 'working'
      : observation.context.stopState?.idleObserved ? 'idle' : 'unknown';
    const current = observation.context.currentModel?.replace(/^(?:Select\s+model\s*:\s*|选择模型[：:]\s*)/iu, '').trim();
    return { ...observation.source.session, status, canStop: !!observation.context.stopState?.control,
      ...(current ? { currentModel: { model: current } } : {}),
      pendingQuestions: pending.pendingQuestions, pendingApprovals: pending.pendingApprovals };
  }

  async decide(sessionId, alias, decision, hooks) {
    const observation = await this.observation(sessionId, hooks);
    let plan;
    try { plan = this.controller.prepareDecision({ ...observation.input, alias, ...decision }); }
    catch (error) { throw bridgePendingError(error); }
    const { sessionId: ignoredSession, nativeCallId, freshFormProof, ...nativeFields } = plan;
    const { sessionId: ignoredProofSession, ...proof } = freshFormProof;
    const nativePlan = { ...nativeFields, expectedExePath: this.executablePath, freshFormProof: proof };
    // Alias is consumed before execution. A helper failure is never replayed.
    const receipt = await this.execute(sessionId, nativePlan, observation.context, hooks);
    hooks?.checkActive?.();
    if (!receipt.uiSubmitted) throw new BridgeError(receipt.attempted ? 'bridge_error' : 'not_capable', receipt.attempted
      ? 'WorkBuddy answer or permission may be partially applied; refresh the desktop request before another action'
      : 'WorkBuddy native request changed before the action');
    // A result appearing can also mean cancellation or failure. Its existence
    // alone must not upgrade the decision to business confirmation.
    return { accepted: receipt.uiSubmitted === true, state: 'submitted' };
  }

  async stop(sessionId, hooks) {
    const observation = await this.observation(sessionId, hooks);
    const control = observation.context.stopState?.control;
    if (!control) throw new BridgeError('not_capable', 'WorkBuddy did not expose a live Stop control in this conversation');
    const identity = observation.input.pendingForms.identityProof;
    const region = observation.context.stopState.conversationRegionHash;
    const plan = { kind: 'stop', expectedExePath: this.executablePath, targetControl: control,
      freshFormProof: { epoch: this.epoch, sequence: observation.input.sequence,
        expectedCandidateIndex: identity.expectedCandidateIndex, candidateCount: identity.candidateCount,
        matchedCandidateIndex: identity.matchedCandidateIndex, conversationHeaderMatches: identity.conversationHeaderMatches,
        historyFingerprint: identity.historyFingerprint, conversationRegionHash: region, scopePathHash: control.pathHash,
        runtimeIdHashes: [control.runtimeIdHash], formFingerprint: crypto.createHash('sha256').update(JSON.stringify(control)).digest('hex') } };
    const receipt = await this.execute(sessionId, plan, observation.context, hooks);
    hooks?.checkActive?.();
    if (!receipt.uiSubmitted) throw new BridgeError(receipt.attempted ? 'bridge_error' : 'not_capable', receipt.attempted
      ? 'WorkBuddy received Stop input but its idle state could not be confirmed; refresh before another action'
      : 'WorkBuddy Stop control changed before the action');
    return { accepted: receipt.uiSubmitted === true, status: 'submitted' };
  }

  retire() { this.retired = true; this.controller.retire(); }
}
module.exports = { WorkBuddyPendingService };
