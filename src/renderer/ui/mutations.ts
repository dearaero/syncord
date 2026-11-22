/** Utility surfaces cannot change Discord's native username/channel anchors.
 * Check each record: mixed batches must still process their native changes.
 * No subtree queries or layout measurements are needed to classify a batch.
 */
export function nativeUiMutationRelevant(records: MutationRecord[], extraOwned = ''): boolean {
  const selector = '#Syncord-settings-root,#Syncord-titlebar-btn,#Syncord-spotify-island,#Syncord-fake-voice-host'
    + (extraOwned ? ',' + extraOwned : '');
  const owned = (node: Node): boolean => {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element?.closest(selector);
  };
  return records.some(record => {
    if (owned(record.target)) return false;
    const nodes = record.type === 'childList' ? [...record.addedNodes, ...record.removedNodes] : [];
    return !nodes.length || !nodes.every(owned);
  });
}
