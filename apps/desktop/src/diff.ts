export interface SideRow {
  left: { no: number | null; text: string } | null;
  right: { no: number | null; text: string } | null;
  type: 'same' | 'change' | 'hunk';
}

export interface FileDiff {
  filePath: string;
  added: number;
  removed: number;
  rows: SideRow[];
}

/** Unified diff 를 파일별 좌우 비교 행으로 변환한다. */
export function parseSideBySide(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;
  let dels: Array<{ no: number; text: string }> = [];
  let adds: Array<{ no: number; text: string }> = [];

  const flush = () => {
    if (!cur) return;
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      cur.rows.push({
        left: dels[i] ? { no: dels[i].no, text: dels[i].text } : null,
        right: adds[i] ? { no: adds[i].no, text: adds[i].text } : null,
        type: 'change',
      });
    }
    dels = [];
    adds = [];
  };

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      flush();
      const m = raw.match(/ b\/(.+)$/);
      cur = { filePath: m ? m[1] : 'unknown', added: 0, removed: 0, rows: [] };
      files.push(cur);
      continue;
    }
    if (!cur) {
      // `--- a/x` / `+++ b/x` 형식만 있는 diff 도 지원
      const m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (m) {
        cur = { filePath: m[1], added: 0, removed: 0, rows: [] };
        files.push(cur);
      }
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file')) continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      cur.rows.push({ left: null, right: null, type: 'hunk' });
      continue;
    }
    if (raw.startsWith('-')) {
      cur.removed++;
      dels.push({ no: oldNo++, text: raw.slice(1) });
    } else if (raw.startsWith('+')) {
      cur.added++;
      adds.push({ no: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith('\\')) {
      continue;
    } else {
      flush();
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      cur.rows.push({ left: { no: oldNo++, text }, right: { no: newNo++, text }, type: 'same' });
    }
  }
  flush();
  return files.filter((f) => f.rows.length > 0);
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.round(hr / 24)}일 전`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
