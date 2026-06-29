"use client";
import { useState } from 'react';
import type { ManifestV3 } from '@etvideoscript/core/browser';

type Operation = ManifestV3['operations'][number];

export function isApprovable(op: Operation): boolean {
  return op.status === 'proposed';
}

export function ApprovalButton({ op, onApprove }: { op: Operation; onApprove: () => Promise<void> | void }) {
  const [approving, setApproving] = useState(false);
  if (!isApprovable(op)) return null;
  async function approve() {
    setApproving(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  }
  return <button type="button" className="approve" disabled={approving} aria-busy={approving} onClick={(event) => { event.stopPropagation(); void approve(); }}>{approving ? 'approving…' : 'Approve'}</button>;
}
