export type DiffLine = {
  type: "equal" | "added" | "removed";
  value: string;
};

export type DiffStats = {
  added: number;
  removed: number;
  equal: number;
};

export type SplitRow = {
  left: DiffLine | null;
  right: DiffLine | null;
};

function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  return dp;
}

export function computeDiff(textA: string, textB: string): DiffLine[] {
  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  const dp = computeLCS(linesA, linesB);

  const result: DiffLine[] = [];
  let i = linesA.length;
  let j = linesB.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.push({ type: "equal", value: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", value: linesB[j - 1] });
      j--;
    } else {
      result.push({ type: "removed", value: linesA[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

export function getDiffStats(diff: DiffLine[]): DiffStats {
  return diff.reduce(
    (accumulator, line) => {
      accumulator[line.type] += 1;
      return accumulator;
    },
    { added: 0, removed: 0, equal: 0 }
  );
}

export function toSplitRows(diff: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;

  while (index < diff.length) {
    const line = diff[index];

    if (line.type === "equal") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }

    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];

    while (index < diff.length && diff[index].type !== "equal") {
      if (diff[index].type === "removed") {
        removed.push(diff[index]);
      } else {
        added.push(diff[index]);
      }
      index++;
    }

    const maxLength = Math.max(removed.length, added.length);
    for (let offset = 0; offset < maxLength; offset++) {
      rows.push({
        left: removed[offset] ?? null,
        right: added[offset] ?? null,
      });
    }
  }

  return rows;
}
