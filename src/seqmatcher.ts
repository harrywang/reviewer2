/**
 * Minimal port of Python's difflib.SequenceMatcher (autojunk=False, no junk),
 * sufficient for quote-coverage matching: getMatchingBlocks over two strings.
 */

export interface MatchBlock {
  a: number;
  b: number;
  size: number;
}

function buildB2J(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    const arr = b2j.get(ch);
    if (arr) arr.push(i);
    else b2j.set(ch, [i]);
  }
  return b2j;
}

function findLongestMatch(
  a: string,
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): MatchBlock {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  // j2len[j] = length of longest match ending at a[i-1], b[j-1]
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const indices = b2j.get(a[i]);
    if (indices) {
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newj2len;
  }
  return { a: besti, b: bestj, size: bestsize };
}

/**
 * Equivalent of SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks().
 * Returns blocks sorted by position, terminated by a zero-size sentinel block.
 */
export function getMatchingBlocks(a: string, b: string): MatchBlock[] {
  const b2j = buildB2J(b);
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const matchingBlocks: MatchBlock[] = [];

  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const m = findLongestMatch(a, b2j, alo, ahi, blo, bhi);
    if (m.size > 0) {
      matchingBlocks.push(m);
      if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
      if (m.a + m.size < ahi && m.b + m.size < bhi) {
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
      }
    }
  }

  matchingBlocks.sort((x, y) => x.a - y.a || x.b - y.b);

  // Merge adjacent blocks (same as difflib)
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent: MatchBlock[] = [];
  for (const { a: i2, b: j2, size: k2 } of matchingBlocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push({ a: i1, b: j1, size: k1 });
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push({ a: i1, b: j1, size: k1 });
  nonAdjacent.push({ a: a.length, b: b.length, size: 0 });
  return nonAdjacent;
}

/** difflib SequenceMatcher.ratio() equivalent. */
export function similarityRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = getMatchingBlocks(a, b).reduce((sum, bl) => sum + bl.size, 0);
  return (2.0 * matches) / (a.length + b.length);
}
