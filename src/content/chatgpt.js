import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { getSettings } from '../lib/settings.js';
import { logger } from '../lib/events.js';
import { DATA_DIR, ensureDirs } from '../lib/paths.js';
import { chromiumOverride } from '../lib/playwright.js';
import { buildPosterPrompt } from './imagegen.js';

/**
 * 구독 중인 ChatGPT 로 썸네일을 만든다.
 *
 * 이미지 생성 API(imagegen.js)는 장당 돈이 든다. ChatGPT 를 이미 구독하고
 * 있다면 그쪽에서 뽑는 편이 추가 비용이 없다. 대신 API 가 아니라 **브라우저로
 * 실제 화면을 조작**하는 방식이라, API 보다 느리고 화면이 바뀌면 깨진다.
 *
 * 그래서 이 파일은 실패를 전제로 쓴다. 여기서 못 만들면 예외를 던지고,
 * 부르는 쪽(thumbnail.js)이 이미지 API 나 HTML 썸네일로 물러선다.
 *
 * 로그인은 **사람이 한 번 직접** 합니다. 프로필 폴더에 세션이 남아서
 * 그다음부터는 자동으로 들어갑니다. 비밀번호는 이 프로그램이 다루지 않습니다.
 */

/** 로그인 세션이 남는 브라우저 프로필. 여기에 쿠키가 저장된다. */
export function profileDir() {
  const configured = String(getSettings().chatgpt.profileDir || '').trim();
  return configured || path.join(DATA_DIR, 'chatgpt-profile');
}

export function hasProfile() {
  try {
    return fs.readdirSync(profileDir()).length > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 브라우저                                                             */
/* ------------------------------------------------------------------ */

let context = null;
let opening = null;

/**
 * 로그인 세션이 붙어 있는 브라우저를 연다.
 *
 * 같은 프로필 폴더로 두 개를 동시에 열 수 없어서 하나만 두고 계속 쓴다.
 * 글 100편을 돌리는 동안 창이 100번 떴다 사라지는 것도 막을 수 있다.
 */
async function getContext({ headless } = {}) {
  if (context) return context;
  if (opening) return opening;

  const settings = getSettings();
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  const executablePath = chromiumOverride();
  opening = chromium.launchPersistentContext(dir, {
    headless: headless ?? Boolean(settings.chatgpt.headless),
    ...(executablePath ? { executablePath } : {}),
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  }).then((ctx) => {
    context = ctx;
    opening = null;
    ctx.on('close', () => { context = null; });
    return ctx;
  }).catch((error) => {
    opening = null;
    throw new Error(`ChatGPT 브라우저를 열지 못했습니다: ${error.message}`);
  });

  return opening;
}

export async function closeChatGpt() {
  const ctx = context;
  context = null;
  await ctx?.close().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 화면 조작                                                            */
/* ------------------------------------------------------------------ */

const CHAT_URL = 'https://chatgpt.com/';

/**
 * 새 대화를 연다.
 *
 * Playwright 의 접속 오류(net::ERR_...)를 그대로 올리면 쓰는 사람은 무슨
 * 말인지 알 수가 없다. 어디서 막힌 것인지 알아볼 수 있게 바꿔서 올린다.
 */
async function openChat(page) {
  try {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    if (/ERR_|net::|Timeout/.test(error.message)) {
      throw new Error(
        'chatgpt.com 에 접속하지 못했습니다. 인터넷 연결이나 회사·학교 네트워크의 '
        + `차단 여부를 확인해 주세요. (${error.message.split('\n')[0].slice(0, 80)})`,
      );
    }
    throw error;
  }
  await page.waitForTimeout(1500);
}

/** 로그인이 안 된 화면인지. 로그인 버튼이나 auth 주소로 판단한다. */
async function looksLoggedOut(page) {
  if (/\/auth\/|\/login/.test(page.url())) return true;
  const loginButton = page.locator(
    '[data-testid="login-button"], button:has-text("Log in"), button:has-text("로그인")',
  ).first();
  return loginButton.isVisible({ timeout: 2000 }).catch(() => false);
}

/**
 * 임시 채팅이 아닌 **일반 채팅**인지 확인하고, 임시면 끈다.
 *
 * 임시 채팅으로 만든 그림은 기록에 남지 않아 나중에 다시 찾을 수가 없다.
 * 주소에 temporary-chat 이 붙어 오는 경우와, 예전에 켜 둔 토글이 그대로
 * 남아 있는 경우가 둘 다 있어서 양쪽을 본다.
 */
async function ensureNormalChat(page) {
  if (/temporary-chat=true/.test(page.url())) {
    await openChat(page);
  }

  // 임시 채팅이 켜져 있으면 화면에 그 표시가 남는다. 보이면 눌러서 끈다.
  const toggle = page.locator(
    '[data-testid="temporary-chat-toggle"], button[aria-label*="임시"], button[aria-label*="Temporary"]',
  ).first();
  const on = await toggle.getAttribute('aria-checked', { timeout: 1500 }).catch(() => null);
  if (on === 'true') {
    await toggle.click().catch(() => {});
    await page.waitForTimeout(600);
    logger.info('ChatGPT 임시 채팅이 켜져 있어 껐습니다. 일반 채팅으로 만듭니다.');
  }

  const banner = page.locator('text=임시 채팅').first();
  if (await banner.isVisible({ timeout: 1000 }).catch(() => false)) {
    await openChat(page);
  }
}

/** 프롬프트 입력칸. ChatGPT 는 textarea 가 아니라 contenteditable 을 쓴다. */
async function typePrompt(page, prompt) {
  const box = page.locator(
    '#prompt-textarea, div[contenteditable="true"], textarea[data-testid="prompt-textarea"]',
  ).first();
  await box.waitFor({ state: 'visible', timeout: 30000 });
  await box.click();
  // 줄바꿈이 섞이면 중간에 전송된다. 한 줄로 눌러서 넣는다.
  await box.fill(prompt.replace(/\s*\n\s*/g, ' ')).catch(async () => {
    await page.keyboard.insertText(prompt.replace(/\s*\n\s*/g, ' '));
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
}

/**
 * 답변에 그림이 올라올 때까지 기다린다.
 *
 * 생성 중에도 흐릿한 미리보기가 img 로 먼저 붙는다. 그걸 그대로 받으면
 * 반쯤 그려진 그림이 썸네일로 올라간다. 그래서 주소가 **한동안 그대로인지**
 * 확인하고 나서 가져온다.
 */
async function waitForImage(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSrc = '';
  let stableSince = 0;

  while (Date.now() < deadline) {
    const src = await page.evaluate(() => {
      const images = [...document.querySelectorAll('img')];
      const picked = images
        .map((img) => img.currentSrc || img.src || '')
        // 아바타, 아이콘, 데이터 URI 는 제외하고 생성된 그림만 고른다.
        .filter((url) => /^https?:/.test(url))
        .filter((url) => /oaiusercontent|files\.oaiusercontent|\/backend-api\/(estuary\/)?content|sediment/.test(url))
        .pop();
      return picked || '';
    }).catch(() => '');

    if (src) {
      if (src === lastSrc) {
        if (!stableSince) stableSince = Date.now();
        // 2초 동안 안 바뀌면 다 그려진 것으로 본다.
        if (Date.now() - stableSince > 2000) return src;
      } else {
        lastSrc = src;
        stableSince = 0;
      }
    }

    // 거절 답변이 오면 더 기다려도 그림이 안 나온다.
    const refused = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return /(만들 수 없|생성할 수 없|도와드릴 수 없|can't (create|generate)|unable to (create|generate))/i
        .test(text.slice(-2000));
    }).catch(() => false);
    if (refused && !src) throw new Error('ChatGPT 가 이미지 생성을 거절했습니다.');

    await page.waitForTimeout(1500);
  }
  throw new Error(`ChatGPT 가 ${Math.round(timeoutMs / 1000)}초 안에 그림을 내놓지 않았습니다.`);
}

/** 그림 주소를 data URI 로 받아온다. 브라우저의 쿠키를 그대로 쓴다. */
async function downloadImage(ctx, src) {
  const response = await ctx.request.get(src, { timeout: 60000 });
  if (!response.ok()) throw new Error(`그림을 내려받지 못했습니다 (HTTP ${response.status()})`);
  const buffer = await response.body();
  if (buffer.length < 2000) throw new Error('받은 그림이 너무 작습니다.');
  const type = (response.headers()['content-type'] || 'image/png').split(';')[0];
  return { dataUri: `data:${type};base64,${buffer.toString('base64')}`, bytes: buffer.length };
}

/* ------------------------------------------------------------------ */
/* 바깥에서 쓰는 것                                                      */
/* ------------------------------------------------------------------ */

/**
 * 로그인 창을 띄운다. 사람이 직접 로그인할 때까지 기다린다.
 *
 * 비밀번호를 프로그램이 받지 않는다. 창을 열어 줄 뿐이고, 로그인하면
 * 프로필 폴더에 세션이 남아 그다음부터는 자동으로 들어간다.
 */
export async function openLoginWindow({ waitMs = 300000 } = {}) {
  ensureDirs();
  await closeChatGpt();                       // 프로필은 한 번에 하나만 열 수 있다.
  const ctx = await getContext({ headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();

  await openChat(page);
  logger.step('ChatGPT 로그인 창을 열었습니다. 창에서 직접 로그인해 주세요.');

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await looksLoggedOut(page))) {
      await page.waitForTimeout(1500);
      if (!(await looksLoggedOut(page))) {
        logger.info('ChatGPT 로그인이 확인됐습니다. 이제 썸네일을 만들 수 있습니다.');
        return { ok: true, message: '로그인이 확인됐습니다.' };
      }
    }
    await page.waitForTimeout(2000);
  }
  return { ok: false, message: '로그인을 확인하지 못했습니다. 창에서 로그인한 뒤 다시 눌러 주세요.' };
}

/** 지금 로그인이 살아 있는지 빠르게 본다. */
export async function checkLogin() {
  if (!hasProfile()) {
    return { ok: false, message: '아직 로그인한 적이 없습니다. [ChatGPT 로그인] 을 먼저 누르세요.' };
  }
  try {
    const ctx = await getContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    await openChat(page);
    return (await looksLoggedOut(page))
      ? { ok: false, message: '로그인이 풀렸습니다. [ChatGPT 로그인] 을 다시 눌러 주세요.' }
      : { ok: true, message: '로그인되어 있습니다.' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

/** 썸네일 문구를 ChatGPT 에게 줄 한 덩어리 지시로 만든다. */
export function buildChatGptPrompt(spec, { poster, width, height, extra = '' }) {
  const ratio = width && height ? `${width}x${height}` : '1200x630';
  return [
    `다음 설명대로 블로그 썸네일 이미지를 1장 만들어 주세요. 가로세로 비율은 ${ratio} 에 가깝게, 가로로 긴 배너 형태입니다.`,
    '설명 문장이나 질문 없이 이미지만 바로 만들어 주세요.',
    '',
    buildPosterPrompt(spec, poster),
    extra ? `\n${extra}` : '',
  ].join('\n');
}

/**
 * ChatGPT 로 썸네일 한 장을 만든다.
 *
 * 실패하면 예외를 던진다. 부르는 쪽이 이미지 API 나 HTML 썸네일로 물러선다.
 *
 * @returns {Promise<{dataUri: string, bytes: number}>}
 */
export async function generateThumbnail(spec, { width, height, signal } = {}) {
  const settings = getSettings();
  if (!hasProfile()) {
    throw new Error('ChatGPT 로그인이 필요합니다. 설정에서 [ChatGPT 로그인] 을 눌러 주세요.');
  }

  const ctx = await getContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  const timeoutMs = Math.max(60000, Number(settings.chatgpt.timeoutMs) || 300000);

  const onAbort = () => page.evaluate(() => window.stop()).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // 매번 새 대화로 시작한다. 앞 대화가 남아 있으면 그 그림을 다시 집어온다.
    await openChat(page);

    if (await looksLoggedOut(page)) {
      throw new Error('ChatGPT 로그인이 풀렸습니다. 설정에서 [ChatGPT 로그인] 을 다시 눌러 주세요.');
    }
    await ensureNormalChat(page);

    const prompt = buildChatGptPrompt(spec, {
      poster: settings.image.poster,
      width,
      height,
      extra: String(settings.chatgpt.promptSuffix || '').trim(),
    });

    logger.step('ChatGPT 에 썸네일을 요청하는 중...');
    await typePrompt(page, prompt);

    const src = await waitForImage(page, timeoutMs);
    const image = await downloadImage(ctx, src);
    logger.info(`ChatGPT 썸네일을 받았습니다 (${Math.round(image.bytes / 1024)}KB)`);
    return image;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
