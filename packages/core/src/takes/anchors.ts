import type { NormalizedWord } from './normalize';

export interface Anchor { refIndex: number; takeIndex: number }

function uniqueShingles(words: NormalizedWord[]): Map<string, number> {
  const counts = new Map<string, { position: number; count: number }>();
  for (let i = 0; i + 2 < words.length; i++) {
    const key = `${words[i].text} ${words[i + 1].text} ${words[i + 2].text}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { position: i, count: 1 });
  }
  const unique = new Map<string, number>();
  for (const [key, { position, count }] of counts) if (count === 1) unique.set(key, position);
  return unique;
}

export function findAnchors(ref: NormalizedWord[], take: NormalizedWord[]): Anchor[] {
  const refShingles = uniqueShingles(ref);
  const takeShingles = uniqueShingles(take);
  const candidates: Anchor[] = [];
  for (const [key, refIndex] of refShingles) {
    const takeIndex = takeShingles.get(key);
    if (takeIndex !== undefined) candidates.push({ refIndex, takeIndex });
  }
  candidates.sort((a, b) => a.refIndex - b.refIndex);

  // Longest strictly-increasing subsequence in takeIndex (O(n log n) patience sorting).
  const tails: number[] = [];        // tails[k] = takeIndex of smallest tail of an increasing subsequence of length k+1
  const tailIdx: number[] = [];      // index into candidates for tails[k]
  const prev: number[] = new Array(candidates.length).fill(-1);
  candidates.forEach((candidate, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < candidate.takeIndex) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = candidate.takeIndex;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const chain: Anchor[] = [];
  let at = tails.length ? tailIdx[tails.length - 1] : -1;
  while (at !== -1) { chain.push(candidates[at]); at = prev[at]; }
  return chain.reverse();
}
