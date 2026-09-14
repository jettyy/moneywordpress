import fs from 'node:fs';
import path from 'node:path';
import { STATUS, updateJob, nextPending, stats, addTopics, listJobs } from '../lib/store.js';
import { getSettings } from '../lib/settings.js';
import { discoverTopics } from '../content/discover.js';
import { recordTopics } from '../lib/history.js';
import { generatePost, countChars } from '../content/generator.js';
import { summarize } from '../content/adsense.js';
import { renderThumbnail } from '../content/thumbnail.js';
import { buildPostContent, buildPreviewHtml } from '../content/gutenberg.js';
import { buildMarkdown } from '../content/markdown.js';
import { saveDraft } from '../wordpress/publisher.js';
import { readSiteInfo } from '../wordpress/client.js';
import { OUTPUT_DIR, ensureDirs } from '../lib/paths.js';
import { logger, push } from '../lib/events.js';
import { sleep, randomBetween, slugify } from '../lib/util.js';

const state = {
  running: false,
  paused: false,
  currentJobId: null,
  abort: null,
  waitUntil: null,

  // 이번 실행의 목표와 진행 상황.
  // saved 는 **이번 실행에서 실제로 임시저장에 성공한 건수**다.
  // 실패하거나 건너뛴 주제는 세지 않는다. 5건을 원했으면 5건이 올라가야 한다.
  goal: 0,
  saved: 0,
  bigTopic: '',
  discovering: false,
};

export function getRunnerState() {
  return {
    running: state.running,
    paused: state.paused,
    currentJobId: state.currentJobId,
    waitUntil: state.waitUntil,
    goal: state.goal,
    saved: state.saved,
    bigTopic: state.bigTopic,
    discovering: state.discovering,
    stats: stats(),
  };
}

function broadcast() {
  push('runner', getRunnerState());
}

/**
 * 결과물을 파일로도 남겨둔다. 워드프레스 저장이 실패해도 글은 살아 있게.
 * post.md 는 구텐베르크 편집기에 그대로 붙여넣을 수 있는 마크다운이다.
 */
function archivePost(job, post, thumbnailPath) {
  ensureDirs();
  const base = `${slugify(job.topic, 30)}-${job.id}`;
  const dir = path.join(OUTPUT_DIR, base);
  fs.mkdirSync(dir, { recursive: true });

  const thumbName = thumbnailPath ? path.basename(thumbnailPath) : '';
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    fs.copyFileSync(thumbnailPath, path.join(dir, thumbName));
  }

  const settings = getSettings();
  const sourcesHeading = settings.research.sourcesHeading;
  const content = buildPostContent(post, '', { moreTag: settings.post.moreTag, sourcesHeading });

  fs.writeFileSync(path.join(dir, 'post.json'), JSON.stringify(post, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'post.md'),
    buildMarkdown(post, { thumbnailFile: thumbName, sourcesHeading }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'content.html'), content, 'utf8');
  fs.writeFileSync(path.join(dir, 'preview.html'), buildPreviewHtml(post, content), 'utf8');

  // 조사 원자료를 따로 남긴다. 발행 전에 "무엇을 근거로 썼는지" 확인하는 용도다.
  if (post.research) {
    fs.writeFileSync(path.join(dir, 'research.json'), JSON.stringify(post.research, null, 2), 'utf8');
  }
  return dir;
}

async function processJob(job) {
  state.currentJobId = job.id;
  broadcast();

  const settings = getSettings();

  updateJob(job.id, {
    status: settings.research.enabled ? STATUS.RESEARCHING : STATUS.WRITING,
    message: settings.research.enabled
      ? '웹에서 최신 자료를 찾는 중...'
      : 'AI가 애드센스 승인 기준에 맞춰 글을 쓰는 중...',
    attempts: job.attempts + 1,
  });
  logger.step(`[${job.topic}] 글 생성 시작`, { jobId: job.id });

  const post = await generatePost(job.topic, {
    signal: state.abort?.signal,
    onResearch: () => {
      if (!settings.research.enabled) return;
      updateJob(job.id, { status: STATUS.RESEARCHING, message: '웹에서 최신 자료를 찾는 중...' });
    },
    onCompliance: () => {
      updateJob(job.id, { status: STATUS.CHECKING, message: '준수 검사에서 걸린 부분을 고쳐 쓰는 중...' });
    },
  });

  const charCount = countChars(post);
  const tableRows = post.table?.rows?.length || 0;
  const compliance = post.compliance;
  const research = post.research;

  const notes = [`공백 제외 ${charCount.toLocaleString()}자`];
  if (research) notes.push(`검색 ${research.searches}회 · 출처 ${post.sources.length}건`);
  if (tableRows) {
    notes.push(post.tableExpected ? `표 ${tableRows}/${post.tableExpected}행` : `표 ${tableRows}행`);
  }
  if (post.tableMissing?.length) notes.push(`누락 ${post.tableMissing.length}건`);
  if (post.repairs) notes.push(`보정 ${post.repairs}회`);
  if (compliance) notes.push(summarize(compliance));

  updateJob(job.id, {
    title: post.title,
    charCount,
    tableRows,
    model: post.model,
    guidelineCheck: post.guidelineCheck,
    compliance,
    repairs: post.repairs || 0,
    searches: research?.searches || 0,
    sourceCount: post.sources?.length || 0,
    unverified: research?.unverified?.length || 0,
    message: `초안 완성 (${notes.join(', ')})`,
  });
  logger.info(
    `[${job.topic}] 초안 완성: "${post.title}" — ${notes.join(', ')}`
    + `${post.model ? ` / 모델 ${post.model}` : ''}`,
    { jobId: job.id },
  );
  if (post.guidelineCheck) {
    logger.info(`[${job.topic}] 지침 반영: ${post.guidelineCheck}`, { jobId: job.id });
  }
  if (research?.unverified?.length) {
    logger.warn(
      `[${job.topic}] 조사에서 확인하지 못한 내용 ${research.unverified.length}건이 있습니다. `
      + `발행 전에 확인하세요: ${research.unverified.slice(0, 3).join(' / ')}`,
      { jobId: job.id },
    );
  }

  // 끝내 규칙을 못 지킨 글을 올리지 않도록 막을 수 있다. 기본값은 "올리되 표시만".
  if (compliance && !compliance.ok) {
    const detail = compliance.issues.map((issue) => `${issue.label}(${issue.detail})`).join(' / ');
    if (settings.adsense.blockOnFail) {
      throw new Error(`애드센스 준수 검사 미통과로 저장하지 않았습니다: ${detail}`);
    }
    logger.warn(`[${job.topic}] 준수 미통과 항목이 남아 있습니다: ${detail}`, { jobId: job.id });
  }

  updateJob(job.id, { status: STATUS.THUMBNAIL, message: '썸네일 만드는 중...' });
  let thumb = { filePath: '', fileName: '', style: '' };
  try {
    thumb = await renderThumbnail(post, { jobId: job.id });
    updateJob(job.id, { thumbnailPath: thumb.fileName, message: `썸네일 완성 (${thumb.style})` });
  } catch (error) {
    // 썸네일은 글의 부속물이다. 여기서 실패했다고 글을 버리지 않는다.
    logger.warn(`[${job.topic}] 썸네일 생성 실패, 글만 저장합니다: ${error.message}`, { jobId: job.id });
  }

  const dir = archivePost(job, post, thumb.filePath);

  updateJob(job.id, { status: STATUS.POSTING, message: '워드프레스에 임시저장하는 중...' });
  const result = await saveDraft({
    post,
    thumbnailPath: thumb.filePath,
    jobId: job.id,
    signal: state.abort?.signal,
  });

  updateJob(job.id, {
    status: STATUS.DONE,
    message: compliance?.ok
      ? '임시저장 완료 (준수 검사 통과)'
      : `임시저장 완료 (${summarize(compliance)})`,
    archiveDir: path.basename(dir),
    editUrl: result.editUrl || '',
    postUrl: result.previewUrl || '',
  });
  logger.info(
    `[${job.topic}] 임시저장 완료 (글 ID ${result.id})${result.editUrl ? ` → ${result.editUrl}` : ''}`,
    { jobId: job.id },
  );
}

// 같은 이유로 계속 실패할 때 남은 주제를 전부 태우지 않도록 하는 한계선.
/**
 * 실패 메시지가 길면 작업표가 글로 뒤덮인다.
 * (AI 가 주제를 거절하면 이유를 몇 문단씩 적어 보낸다)
 * 표에는 짧게 띄우고 전체 내용은 따로 담아 마우스를 올렸을 때 보이게 한다.
 */
function shorten(message, max = 160) {
  const text = String(message).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * 대기 중인 주제가 떨어졌을 때 큰 주제로 다시 발굴해 채운다.
 *
 * 목표까지 남은 건수보다 조금 넉넉히 받아 온다. 주제 하나가 거절당하거나
 * 실패할 수 있어서, 딱 맞춰 받아 오면 매번 다시 발굴하러 나가야 한다.
 * 발굴은 검색이 여러 번 도는 비싼 호출이라 횟수를 줄이는 편이 낫다.
 *
 * @returns {Promise<number>} 실제로 작업 목록에 들어간 건수
 */
async function refillQueue(remaining) {
  const settings = getSettings();
  const want = Math.min(
    Math.max(settings.discover.batchSize, remaining),
    remaining + 2,
  );

  state.discovering = true;
  broadcast();
  try {
    // 아직 안 쓴 대기 주제도 제외 목록에 넣는다. 목록에 있는데 또 골라 오면
    // addTopics 가 걸러내긴 하지만, 애초에 다른 주제를 골라 오는 편이 낫다.
    const exclude = listJobs().map((job) => job.topic);
    const result = await discoverTopics(state.bigTopic, {
      want,
      exclude,
      signal: state.abort?.signal,
    });

    if (!result.picks.length) {
      logger.warn(
        `[${state.bigTopic}] 새로 쓸 만한 주제를 찾지 못했습니다. `
        + '큰 주제를 조금 넓히거나, 설정에서 관심도 점수 하한을 낮춰 보세요.',
      );
      return 0;
    }

    // 실제로 글을 썼는지와 무관하게 발굴한 시점에 기록한다.
    // 실패한 주제를 다음 발굴에서 또 골라 와 또 실패하는 일을 막는다.
    recordTopics(state.bigTopic, result.picks);
    const added = addTopics(result.picks);
    logger.info(`[${state.bigTopic}] 주제 ${added.length}건을 작업 목록에 추가했습니다.`);
    return added.length;
  } finally {
    state.discovering = false;
    broadcast();
  }
}

/**
 * 다음에 무엇을 할지 정한다.
 *
 * 이 판단이 틀리면 두 가지 중 하나가 난다. 목표를 못 채우고 일찍 끝나거나,
 * 아니면 끝없이 돌면서 검색 호출만 태운다. 둘 다 자는 동안 벌어지는 일이라
 * 판단만 따로 떼어 놓고 자체 점검에서 확인한다.
 *
 * @returns {'done'|'process'|'discover'|'stop-empty'|'stop-cap'}
 */
export function planNextStep({
  saved, goal, hasPending, bigTopic, queued, queuedCap,
}) {
  if (goal > 0 && saved >= goal) return 'done';       // 목표를 채웠다. 대기가 남아도 끝낸다.
  if (hasPending) return 'process';                   // 쓸 주제가 있으면 그것부터.
  if (!bigTopic || goal <= 0) return 'stop-empty';    // 큰 주제가 없으면 예전처럼 여기서 끝.
  if (queued >= queuedCap) return 'stop-cap';         // 계속 찾아오는데 저장이 안 된다.
  return 'discover';
}

async function loop() {
  let processed = 0;
  let consecutiveFailures = 0;
  // 발굴을 나갔는데 한 건도 못 건진 횟수. 계속 빈손이면 무한히 돌 수 있다.
  let emptyDiscoveries = 0;
  // 이번 실행에서 발굴로 집어넣은 주제 수.
  //
  // 목표를 채울 때까지 계속 도는 구조라, 글이 전부 실패하면(워드프레스가 내려갔다든지)
  // "찾아오고 → 실패하고 → 다시 찾아오고" 를 끝없이 반복하게 된다. 주제는 계속
  // 늘어나는데 저장된 글은 하나도 안 늘어나는 상태다. 그럴 때 멈출 선을 하나 둔다.
  const queuedCap = Math.max(10, state.goal * 2 + 5);
  let queued = 0;

  while (state.running) {
    if (state.paused) {
      await sleep(700);
      continue;
    }

    let job = nextPending();
    const step = planNextStep({
      saved: state.saved,
      goal: state.goal,
      hasPending: Boolean(job),
      bigTopic: state.bigTopic,
      queued,
      queuedCap,
    });

    // 목표를 채웠으면 대기 주제가 남아 있어도 여기서 끝낸다.
    // "몇 개 임시저장하고 끝낼지" 를 정해 둔 이유가 그것이다.
    if (step === 'done') {
      logger.info(`목표한 ${state.goal}건을 모두 임시저장했습니다. 실행을 마칩니다.`);
      break;
    }
    if (step === 'stop-empty') {
      logger.info('대기 중인 주제가 없습니다. 실행을 마칩니다.');
      break;
    }
    if (step === 'stop-cap') {
      logger.error(
        `주제를 ${queued}건이나 찾았는데 임시저장된 글은 ${state.saved}건뿐이라 실행을 멈춥니다. `
        + '워드프레스 연결이나 준수 검사 설정에 문제가 있을 수 있습니다. '
        + '작업표의 실패 메시지를 확인해 주세요.',
      );
      break;
    }

    // 대기 주제가 떨어졌다. 큰 주제로 웹 검색을 돌려 새로 찾아온다.
    if (step === 'discover') {
      const remaining = state.goal - state.saved;
      let added = 0;
      try {
        added = await refillQueue(remaining);
      } catch (error) {
        if (error.rateLimited) {
          state.paused = true;
          logger.error(`주제를 찾는 중 사용량 한도에 걸려 일시정지했습니다. ${error.message}`);
          broadcast();
          continue;
        }
        if (/중지했습니다/.test(error.message)) break;
        logger.error(`주제 발굴에 실패했습니다: ${error.message}`);
      }

      if (!added) {
        emptyDiscoveries += 1;
        // 두 번 연달아 빈손이면 더 돌려도 같다. 검색 호출만 버린다.
        if (emptyDiscoveries >= 2) {
          logger.warn('두 번 연속으로 새 주제를 찾지 못해 실행을 멈춥니다.');
          break;
        }
        await sleep(3000);
        continue;
      }
      emptyDiscoveries = 0;
      queued += added;
      job = nextPending();
    }

    // 찾아오긴 했는데 전부 중복이라 대기가 안 생긴 경우다.
    // 위로 돌아가 다시 판단한다. (발굴 상한이 있어서 무한히 돌지 않는다)
    if (!job) continue;

    try {
      await processJob(job);
      consecutiveFailures = 0;
      state.saved += 1;
      broadcast();
      if (state.goal > 0) {
        logger.info(`진행 ${state.saved}/${state.goal}건 임시저장 완료.`);
      }
    } catch (error) {
      const message = error.message || String(error);

      // 사용량 한도는 계속 돌려도 전부 실패한다. 멈추고 사람이 판단하게 둔다.
      if (error.rateLimited) {
        updateJob(job.id, { status: STATUS.PENDING, message: `사용량 한도로 대기: ${message}` });
        state.paused = true;
        logger.error(`사용량 한도에 걸려 일시정지했습니다. 잠시 뒤 [이어서 실행]을 눌러주세요. ${message}`);
        broadcast();
        continue;
      }

      // AI 가 "이 주제로는 못 쓰겠다" 고 거절한 경우다.
      // 같은 주제로 다시 물어봐야 같은 대답이 온다. 재시도는 호출만 버리는 짓이고,
      // 설정이 잘못된 것도 아니니 연속 실패로 세지도 않는다. 바로 다음 주제로 간다.
      if (error.refusal) {
        updateJob(job.id, {
          status: STATUS.SKIPPED,
          message: `AI가 이 주제를 거절했습니다: ${shorten(error.reason || message)}`,
          detail: String(error.reason || message),
        });
        logger.warn(
          `[${job.topic}] AI가 이 주제를 거절해 건너뜁니다. ${shorten(error.reason || message, 200)}`,
          { jobId: job.id },
        );
        continue;
      }

      consecutiveFailures += 1;
      const canRetry = job.attempts <= getSettings().run.maxRetries;
      if (canRetry && state.running) {
        updateJob(job.id, {
          status: STATUS.PENDING,
          message: `실패, 재시도 예정: ${shorten(message)}`,
          detail: message,
        });
        logger.warn(`[${job.topic}] 실패 - 재시도합니다. ${shorten(message, 200)}`, { jobId: job.id });
        await sleep(5000);
      } else {
        updateJob(job.id, { status: STATUS.FAILED, message: shorten(message), detail: message });
        logger.error(`[${job.topic}] 실패: ${shorten(message, 200)}`, { jobId: job.id });
      }

      // 설정이 잘못됐거나 연결이 끊긴 상태라면 남은 주제도 전부 같은 이유로 실패한다.
      // 그래도 기본값은 "멈추지 않고 계속" 이다. 한두 주제가 안 된다고 나머지
      // 아흔 몇 건을 세워두는 것보다, 끝까지 돌려놓고 실패한 것만 다시 보는 편이 낫다.
      // 설정에서 0 이 아닌 값을 주면 그 횟수만큼 연속 실패했을 때 멈춘다.
      const stopAfter = Number(getSettings().run.stopAfterFailures) || 0;
      if (stopAfter > 0 && consecutiveFailures >= stopAfter) {
        logger.error(
          `연속 ${consecutiveFailures}건이 실패해 실행을 멈춥니다. `
          + `마지막 오류: ${shorten(message, 200)}`,
        );
        state.running = false;
      }
    } finally {
      state.currentJobId = null;
      broadcast();
    }

    processed += 1;
    if (!state.running) break;
    // 끝낼 때가 됐는지는 위에서 한 곳에서만 판단한다. 여기서는 더 할 일이
    // 있는지만 보고, 있으면 다음 글까지 사이를 띄운다.
    const next = planNextStep({
      saved: state.saved,
      goal: state.goal,
      hasPending: Boolean(nextPending()),
      bigTopic: state.bigTopic,
      queued,
      queuedCap,
    });
    if (next !== 'process' && next !== 'discover') continue;    // 위에서 마무리 로그를 찍고 끝낸다.

    // 짧은 시간에 몰아서 올리면 호스팅의 요청 제한에 걸릴 수 있다. 사이를 띄운다.
    const { delayMinSec, delayMaxSec } = getSettings().run;
    const wait = randomBetween(
      Math.max(0, delayMinSec) * 1000,
      Math.max(delayMinSec, delayMaxSec) * 1000,
    );
    state.waitUntil = Date.now() + wait;
    broadcast();
    logger.info(`다음 글까지 ${Math.round(wait / 1000)}초 대기합니다.`);

    const until = Date.now() + wait;
    while (Date.now() < until && state.running) await sleep(500);
    state.waitUntil = null;
  }

  state.running = false;
  state.paused = false;
  state.currentJobId = null;
  state.waitUntil = null;
  state.discovering = false;
  broadcast();
  logger.info(
    `실행 종료. 이번 실행에서 ${processed}건 처리했고 `
    + `${state.saved}건을 임시저장했습니다${state.goal ? ` (목표 ${state.goal}건)` : ''}.`,
  );
}

export function start() {
  if (state.running) return { ok: false, message: '이미 실행 중입니다.' };

  const settings = getSettings();
  const bigTopic = String(settings.discover.bigTopic || '').trim();
  const goal = Math.max(0, Number(settings.discover.targetCount) || 0);

  // 큰 주제가 없으면 예전처럼 "대기 중인 주제를 다 쓰고 끝" 으로 돈다.
  // 직접 추가한 주제만으로 돌려보고 싶을 때를 위해 남겨 둔다.
  if (!bigTopic && !nextPending()) {
    return {
      ok: false,
      message: '2번 칸에 큰 주제를 입력하거나, 직접 주제를 추가한 뒤에 실행해 주세요.',
    };
  }
  if (bigTopic && goal < 1) {
    return { ok: false, message: '임시저장할 개수를 1 이상으로 정해 주세요.' };
  }

  const site = readSiteInfo();
  if (!site.connected) {
    return { ok: false, message: '먼저 워드프레스 연결을 확인해 주세요. (1번 칸의 [연결 확인])' };
  }
  if (!site.canPublish) {
    return { ok: false, message: '이 계정에는 글쓰기 권한이 없습니다. 권한이 있는 계정으로 바꿔 주세요.' };
  }

  state.running = true;
  state.paused = false;
  state.abort = new AbortController();
  state.bigTopic = bigTopic;
  state.goal = bigTopic ? goal : 0;
  state.saved = 0;
  broadcast();
  logger.info(
    bigTopic
      ? `실행 시작 - 큰 주제 "${bigTopic}" 로 ${goal}건을 임시저장할 때까지 계속합니다. `
        + `(대기 ${stats().pending}건)`
      : `실행 시작 - 대기 ${stats().pending}건`,
  );
  loop().catch((error) => {
    logger.error(`실행 루프 오류: ${error.message}`);
    state.running = false;
    state.discovering = false;
    broadcast();
  });
  return { ok: true };
}

export function pause() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.paused = !state.paused;
  broadcast();
  logger.info(state.paused ? '일시정지했습니다.' : '다시 시작합니다.');
  return { ok: true, paused: state.paused };
}

export function stop() {
  if (!state.running) return { ok: false, message: '실행 중이 아닙니다.' };
  state.running = false;
  state.paused = false;
  state.abort?.abort();
  broadcast();
  logger.info('중지 요청을 받았습니다. 진행 중인 글을 마치고 멈춥니다.');
  return { ok: true };
}
