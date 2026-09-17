export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(text, max = 40) {
  return String(text)
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || 'post';
}

/**
 * 워드프레스 주소(permalink)에 들어갈 슬러그.
 * 한글 제목을 그대로 쓰면 주소가 퍼센트 인코딩으로 길어지므로
 * AI 가 준 영문 슬러그를 쓰고, 없으면 빈 값으로 둬 워드프레스에 맡긴다.
 */
export function normalizeSlug(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}

/**
 * 엑셀에서 복사한 덩어리를 주제 목록으로 만든다.
 * 줄 단위로 자르고, 탭/여러 칸으로 나뉜 경우 첫 번째 열만 주제로 본다.
 */
export function parseTopics(raw = '') {
  const seen = new Set();
  const topics = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const cell = line.split('\t')[0].trim().replace(/^["']|["']$/g, '').trim();
    if (!cell) continue;
    // 엑셀 첫 줄이 머리글인 경우가 잦아서 걸러낸다.
    if (topics.length === 0 && /^(주제|제목|topic|title|키워드|keyword)$/i.test(cell)) continue;
    const key = cell.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(cell);
  }
  return topics;
}

/**
 * 큰 주제를 여러 줄 붙여넣은 덩어리를 주문 목록으로 만든다.
 *
 * `parseTopics` 와 나눠 둔 이유가 있다. 저쪽은 "글 하나당 한 줄"이고
 * 이쪽은 "주문 하나당 한 줄"이다. 한 줄이 글 여러 편으로 불어나기 때문에
 * 잘못 섞이면 20줄을 붙여넣었다가 200편이 걸린다.
 *
 * 붙여넣는 모양이 제각각이라 다음을 모두 받아 준다.
 *   대학 입결 순위            (줄 사이에 빈 줄이 있어도 됨)
 *   - 대학 입결 순위          (목록 기호)
 *   1. 대학 입결 순위         (번호 매기기)
 *   대학 입결 순위<TAB>15     (엑셀 2열에 개수를 적은 경우)
 *
 * @returns {{bigTopic: string, targetCount: number}[]} targetCount 가 0 이면 기본값을 쓰라는 뜻
 */
export function parseBigTopics(raw = '') {
  const seen = new Set();
  const list = [];

  for (const line of String(raw).split(/\r?\n/)) {
    const cells = line.split('\t');
    const topic = cells[0]
      .trim()
      .replace(/^["']|["']$/g, '')
      // 목록 기호와 번호를 떼어낸다. 그대로 두면 큰 주제에 "1." 이 붙어 검색된다.
      .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '')
      .trim()
      .slice(0, 80);
    if (!topic) continue;
    // 엑셀에서 머리글째 복사한 경우.
    if (/^(큰\s*주제|주제|제목|topic|title|키워드|keyword)$/i.test(topic)) continue;

    // 같은 덩어리 안에서 겹치는 줄은 버린다. 붙여넣기는 실수로 겹치기 쉽다.
    const key = topic.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const count = Number(String(cells[1] ?? '').trim());
    list.push({
      bigTopic: topic,
      targetCount: Number.isFinite(count) && count > 0 ? Math.min(200, Math.round(count)) : 0,
    });
  }
  return list;
}

export function nowIso() {
  return new Date().toISOString();
}

export function shortId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/** 사이트 주소 정리. 끝 슬래시와 /wp-admin, /wp-json 꼬리를 떼어낸다. */
export function normalizeSiteUrl(raw = '') {
  let url = String(raw).trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/(wp-admin|wp-login\.php|wp-json)(\/.*)?$/i, '');
  return url.replace(/\/+$/, '');
}
