/**
 * Host half of 思想星图 (Thought Constellation).
 *
 * Owns the local archive (one JSON per project under 文档/思想工坊) and the
 * analysis call to the current model. The browser talks to it through the
 * plugin's own same-origin HTTP routes; the web server adapter hands us the
 * raw Node request/response pair.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API_PREFIX = '/thought-constellation/api';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_CHARS = 40000;
const MAX_CORPUS_CHARS = 30000;
const MAX_OUTPUT_TOKENS = 8000;
const ANALYZE_TIMEOUT_MS = 180000;

const RELATION_TYPES = new Set(['support', 'cause', 'oppose', 'progress', 'example']);
const CLAIM_KINDS = new Set(['assertion', 'assumption', 'causal', 'value', 'example', 'prediction']);

/* ------------------------------------------------------------------ storage */

function storageRoot(config) {
  const custom = config && typeof config.storageDir === 'string' ? config.storageDir.trim() : '';
  return custom || path.join(os.homedir(), 'Documents', '思想工坊');
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function projectFile(root, id) {
  return path.join(root, `proj_${id}.json`);
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

async function ensureRoot(root) {
  await fs.mkdir(root, { recursive: true });
}

async function readIndex(root) {
  const index = await readJson(path.join(root, 'index.json'), { version: 1, projects: [] });
  if (!index || !Array.isArray(index.projects)) return { version: 1, projects: [] };
  return index;
}

async function writeIndex(root, index) {
  await writeJson(path.join(root, 'index.json'), { version: 1, projects: index.projects });
}

function summaryOf(project) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    entryCount: Array.isArray(project.entries) ? project.entries.length : 0,
    hasAnalysis: Boolean(project.analysis),
  };
}

async function readProject(root, id) {
  if (!validId(id)) throw httpError(400, '无效的项目 id');
  const project = await readJson(projectFile(root, id), null);
  if (!project) throw httpError(404, '项目不存在');
  return project;
}

async function saveProject(root, project) {
  project.updatedAt = new Date().toISOString();
  await writeJson(projectFile(root, project.id), project);
  const index = await readIndex(root);
  const summary = summaryOf(project);
  const at = index.projects.findIndex(item => item.id === project.id);
  if (at >= 0) index.projects[at] = summary;
  else index.projects.unshift(summary);
  index.projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await writeIndex(root, index);
  return project;
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* --------------------------------------------------------------- validation */

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim().slice(0, max);
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim().slice(0, maxLength));
    else if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim()) {
      const title = item.title && typeof item.title === 'string' ? item.title.trim().slice(0, 60) : '';
      out.push(title ? `${title}：${item.text.trim().slice(0, maxLength)}` : item.text.trim().slice(0, maxLength));
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

function stripFences(raw) {
  let value = String(raw || '').trim();
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) value = fence[1].trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  return value;
}

function normalizeAnalysis(raw, entries) {
  const entryById = new Map(entries.map(entry => [entry.id, entry]));
  const themeIds = new Set();

  const themes = (Array.isArray(raw.themes) ? raw.themes : []).slice(0, 8).map((theme, i) => {
    const item = theme && typeof theme === 'object' ? theme : {};
    const id = text(item.id, 40) || `t${i + 1}`;
    return {
      id: themeIds.has(id) ? `t${i + 1}_${themeIds.size}` : id,
      title: text(item.title, 80),
      summary: text(item.summary, 240),
    };
  }).filter(theme => {
    if (!theme.title || themeIds.has(theme.id)) return false;
    themeIds.add(theme.id);
    return true;
  });

  if (!themes.length) throw new Error('分析结果缺少有效的主题（themes）');

  const firstTheme = themes[0].id;
  const claimIds = new Set();
  const claims = (Array.isArray(raw.claims) ? raw.claims : []).slice(0, 26).map((claim, i) => {
    const item = claim && typeof claim === 'object' ? claim : {};
    const id = text(item.id, 40) || `c${i + 1}`;
    const themeId = text(item.themeId, 40);
    const kind = text(item.kind, 20);
    const confidence = typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1
      ? item.confidence
      : 0.6;
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).slice(0, 3).flatMap(piece => {
      if (!piece || typeof piece !== 'object') return [];
      const entryId = text(piece.entryId, 40);
      const quote = text(piece.quote, 600);
      const entry = entryById.get(entryId);
      if (!entry || quote.length < 4) return [];
      if (!entry.text.includes(quote)) return [];
      const at = entry.text.indexOf(quote);
      const context = entry.text.slice(Math.max(0, at - 60), Math.min(entry.text.length, at + quote.length + 60)).trim();
      return [{ entryId, quote, context }];
    });
    return {
      id: claimIds.has(id) ? `c${i + 1}_${claimIds.size}` : id,
      themeId: themeIds.has(themeId) ? themeId : firstTheme,
      text: text(item.text, 300),
      kind: CLAIM_KINDS.has(kind) ? kind : 'assertion',
      confidence,
      evidence,
    };
  }).filter(claim => {
    if (!claim.text || claimIds.has(claim.id)) return false;
    claimIds.add(claim.id);
    return true;
  });

  if (!claims.length) throw new Error('分析结果缺少有效的观点（claims）');

  const relationKeys = new Set();
  const relations = (Array.isArray(raw.relations) ? raw.relations : []).slice(0, 60).flatMap(relation => {
    if (!relation || typeof relation !== 'object') return [];
    const from = text(relation.from, 40);
    const to = text(relation.to, 40);
    const type = text(relation.type, 20);
    if (!claimIds.has(from) || !claimIds.has(to) || from === to || !RELATION_TYPES.has(type)) return [];
    const key = `${from}>${to}>${type}`;
    if (relationKeys.has(key)) return [];
    relationKeys.add(key);
    return [{ from, to, type, note: text(relation.note, 120) }];
  });

  const questions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 8).flatMap((question, i) => {
    if (!question || typeof question !== 'object') return [];
    const value = text(question.text, 200);
    if (!value) return [];
    const claimIdsOf = Array.isArray(question.claimIds)
      ? question.claimIds.map(id => text(id, 40)).filter(id => claimIds.has(id)).slice(0, 4)
      : [];
    return [{
      id: text(question.id, 40) || `q${i + 1}`,
      text: value,
      claimIds: claimIdsOf,
      why: text(question.why, 160),
    }];
  });

  const synthesisRaw = raw.synthesis && typeof raw.synthesis === 'object' ? raw.synthesis : {};
  const synthesis = {
    logicChain: stringList(synthesisRaw.logicChain, 8, 200),
    tensions: stringList(synthesisRaw.tensions, 6, 200),
    blindSpots: stringList(synthesisRaw.blindSpots, 6, 200),
    nextSteps: stringList(synthesisRaw.nextSteps, 6, 160),
  };

  const coreThesis = text(raw.coreThesis, 300);
  if (!coreThesis) throw new Error('分析结果缺少核心命题（coreThesis）');

  return { coreThesis, themes, claims, relations, questions, synthesis };
}

/* --------------------------------------------------------------------- llm */

function buildCorpus(entries) {
  const formatted = entries.map(entry => ({
    entry,
    block: `【片段 ${entry.id} · ${new Date(entry.createdAt).toLocaleDateString('zh-CN')}】\n${entry.text}`,
  }));
  const total = formatted.reduce((sum, item) => sum + item.block.length, 0);
  if (total <= MAX_CORPUS_CHARS) return formatted.map(item => item.block).join('\n\n');

  const recent = [];
  let used = 0;
  for (let i = formatted.length - 1; i >= 0; i -= 1) {
    const length = formatted[i].block.length;
    if (used + length > MAX_CORPUS_CHARS - 6000 && recent.length) break;
    recent.unshift(formatted[i]);
    used += length;
  }
  const order = new Set(recent.map(item => item.entry.id));
  const older = formatted.filter(item => !order.has(item.entry.id));
  const condensed = older.map(item => (
    `【片段 ${item.entry.id} · 较早，节选】\n${item.entry.text.slice(0, 320).replace(/\s+/g, ' ')}${item.entry.text.length > 320 ? '…' : ''}`
  )).join('\n\n');
  return `${condensed}\n\n（以上较早片段为节选，下面是完整片段）\n\n${recent.map(item => item.block).join('\n\n')}`;
}

const SYSTEM_PROMPT = `你是一位严谨的思想整理专家。用户会把多个思想片段的原文交给你，你要把它们读成一个整体，抽出主题、观点、观点之间的关系、尚未想清楚的问题，并写出对整套思考的总结。

只输出一个 JSON 对象，不要输出 Markdown 代码块，不要输出任何解释文字。JSON 结构必须完全符合：

{
  "coreThesis": "一句话概括这套思考真正在主张什么，40 字以内",
  "themes": [{ "id": "t1", "title": "主题名，8 字以内", "summary": "这个主题在讨论什么，60 字以内" }],
  "claims": [{
    "id": "c1",
    "themeId": "t1",
    "text": "观点本身，一句话，40 字以内",
    "kind": "assertion | assumption | causal | value | example | prediction",
    "confidence": 0.0,
    "evidence": [{ "entryId": "片段 id", "quote": "原文中逐字出现的一句，不要改写" }]
  }],
  "relations": [{ "from": "c1", "to": "c2", "type": "support | cause | oppose | progress | example", "note": "关系的一句话说明，20 字以内" }],
  "questions": [{ "id": "q1", "text": "尚未回答的问题，30 字以内", "claimIds": ["c1"], "why": "为什么这个问题重要，40 字以内" }],
  "synthesis": {
    "logicChain": ["论证链的一步，每条一句话"],
    "tensions": ["这套思考内部的张力或矛盾"],
    "blindSpots": ["没有被考虑到的盲点"],
    "nextSteps": ["下一步值得想清楚的一件事"]
  }
}

硬性要求：
1. themes 数量 3 到 7 个；claims 数量 6 到 20 个；questions 数量 3 到 6 个。
2. relations 的 from 和 to 必须引用 claims 里已有的 id；questions 的 claimIds 也必须引用已有 id。
3. evidence.quote 必须从对应片段的原文里逐字复制，不允许改字、概括或拼接；entryId 必须是下面出现过的片段 id。
4. 所有文字用简体中文。confidence 在 0 到 1 之间，表示这个观点在原文中的支撑强度。
5. 如果原文观点还少，就少给观点，但不要编造原文没有的内容。`;

function userPrompt(entries) {
  return `下面是全部思想片段的原文：\n\n${buildCorpus(entries)}\n\n请按系统提示里的 JSON 结构输出这张思想星图。`;
}

async function collect(stream) {
  let textOut = '';
  let finish = null;
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') textOut += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const message = finish.failure && (finish.failure.message || finish.failure.detail);
    throw new Error(message || (finish.kind === 'aborted' ? '分析被中断' : '模型调用失败'));
  }
  if (finish && finish.kind === 'max-tokens') {
    throw new Error('模型输出被截断（达到输出上限），请重试或减少片段数量');
  }
  if (!textOut.trim()) throw new Error('模型没有返回内容');
  return textOut;
}

async function askModel(host, messages) {
  const selection = host.get('agentDefaultModel');
  const chosen = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null;
  if (!chosen || !chosen.provider || !chosen.model) {
    throw httpError(409, '还没有可用的模型，请先在设置里选择一个模型');
  }
  const llm = host.get('llm');
  if (!llm || typeof llm.stream !== 'function') throw httpError(503, '模型服务不可用');
  const options = {
    provider: chosen.provider,
    model: chosen.model,
    system: SYSTEM_PROMPT,
    messages,
    temperature: 0.3,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
  };
  if (chosen.reasoningEffort) options.reasoningEffort = chosen.reasoningEffort;
  return collect(llm.stream(options));
}

async function analyzeWithModel(host, entries) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: userPrompt(entries) }] }];
  let firstText = '';
  try {
    firstText = await askModel(host, messages);
    return normalizeAnalysis(JSON.parse(stripFences(firstText)), entries);
  } catch (firstError) {
    if (firstError && firstError.status) throw firstError;
    const repair = [
      ...messages,
      { role: 'assistant', content: [{ type: 'text', text: String(firstText || '').slice(0, 4000) }] },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: `上一个输出无法使用（${firstError.message}）。请重新输出完整、严格合法的 JSON 对象，不要代码块、不要解释；themes 3-7 个、claims 6-20 个、questions 3-6 个，relations 与 claimIds 只能引用已有 claim id，evidence.quote 必须逐字来自原文。`,
        }],
      },
    ];
    const secondText = await askModel(host, repair);
    try {
      return normalizeAnalysis(JSON.parse(stripFences(secondText)), entries);
    } catch (secondError) {
      throw httpError(422, `模型输出格式不正确（已重试一次）：${secondError.message}`);
    }
  }
}

/* ------------------------------------------------------------------- routes */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, '内容太长，请分成几段上传');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, '请求格式不正确');
  }
}

function loopbackHost(host) {
  const name = String(host || '').replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

function sameOrigin(request) {
  if (!loopbackHost(request.headers.host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function admit(ctx, request, response) {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: 'forbidden' });
    return false;
  }
  // Local development probe: loopback-only requests may opt out of the
  // session gate with an explicit header (used by curl during smoke tests).
  if (request.headers['x-thought-constellation-dev'] === '1') return true;
  try {
    const connection = ctx.get('connection');
    const rejection = connection && typeof connection.requestRejection === 'function'
      ? connection.requestRejection(request)
      : undefined;
    if (rejection) {
      sendJson(response, rejection, { error: 'unauthorized' });
      return false;
    }
  } catch {
    /* no connection gate available: same-origin check already passed */
  }
  return true;
}

function createRouter(ctx, root, running) {
  async function guard(request, response, handler) {
    try {
      if (!admit(ctx, request, response)) return;
      const result = await handler();
      if (result !== undefined) sendJson(response, 200, result);
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      sendJson(response, status, { error: String(error && error.message ? error.message : error) });
    }
  }

  return {
    async index(request, response) {
      await guard(request, response, async () => {
        await ensureRoot(root);
        const index = await readIndex(root);
        return { projects: index.projects };
      });
    },

    async project(request, response) {
      await guard(request, response, async () => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const project = await readProject(root, url.searchParams.get('id'));
        return { project };
      });
    },

    async create(request, response) {
      await guard(request, response, async () => {
        const body = await readBody(request);
        const name = text(body.name, 40) || '未命名思想';
        await ensureRoot(root);
        const now = new Date().toISOString();
        const project = {
          version: 1,
          id: newId('p'),
          name,
          createdAt: now,
          updatedAt: now,
          entries: [],
          analysis: null,
          analyzedAt: null,
        };
        await saveProject(root, project);
        return { project, summary: summaryOf(project) };
      });
    },

    async rename(request, response) {
      await guard(request, response, async () => {
        const body = await readBody(request);
        const project = await readProject(root, body.id);
        const name = text(body.name, 40);
        if (!name) throw httpError(400, '项目名不能为空');
        project.name = name;
        await saveProject(root, project);
        return { summary: summaryOf(project) };
      });
    },

    async remove(request, response) {
      await guard(request, response, async () => {
        const body = await readBody(request);
        const project = await readProject(root, body.id);
        if (running.has(project.id)) throw httpError(409, '这个项目正在分析，稍后再删');
        await fs.rm(projectFile(root, project.id), { force: true });
        const index = await readIndex(root);
        index.projects = index.projects.filter(item => item.id !== project.id);
        await writeIndex(root, index);
        return { removed: project.id, projects: index.projects };
      });
    },

    async addEntry(request, response) {
      await guard(request, response, async () => {
        const body = await readBody(request);
        const value = text(body.text, MAX_ENTRY_CHARS);
        if (value.length < 2) throw httpError(400, '这段内容太短了');
        const project = await readProject(root, body.projectId);
        const entry = { id: newId('e'), text: value, createdAt: new Date().toISOString() };
        project.entries.push(entry);
        await saveProject(root, project);
        return { project, entryCount: project.entries.length };
      });
    },

    async deleteEntry(request, response) {
      await guard(request, response, async () => {
        const body = await readBody(request);
        const project = await readProject(root, body.projectId);
        const before = project.entries.length;
        project.entries = project.entries.filter(entry => entry.id !== body.entryId);
        if (project.entries.length === before) throw httpError(404, '片段不存在');
        await saveProject(root, project);
        return { project };
      });
    },

    async analyze(request, response) {
      await guard(request, response, async () => {
        const body = await readBody(request);
        const project = await readProject(root, body.projectId);
        if (!project.entries.length) throw httpError(400, '至少先上传一段思考');
        if (running.has(project.id)) throw httpError(409, '这个项目正在分析中');
        running.add(project.id);
        try {
          const analysis = await analyzeWithModel(ctx, project.entries);
          project.analysis = analysis;
          project.analyzedAt = new Date().toISOString();
          await saveProject(root, project);
          return { project };
        } finally {
          running.delete(project.id);
        }
      });
    },
  };
}

/* --------------------------------------------------------------------- boot */

export function apply(ctx, config) {
  ctx.inject(['webServer'], (host) => {
    const root = storageRoot(config);
    const running = new Set();
    const router = createRouter(host, root, running);
    const routes = [
      ['/index', router.index],
      ['/project', router.project],
      ['/project/create', router.create],
      ['/project/rename', router.rename],
      ['/project/delete', router.remove],
      ['/entry/add', router.addEntry],
      ['/entry/delete', router.deleteEntry],
      ['/analyze', router.analyze],
    ];
    host.effect(() => {
      const disposers = routes.map(([suffix, handler]) => host.webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}${suffix}`,
        handler: (request, response) => handler(request, response),
      }));
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* already gone */
          }
        }
      };
    }, 'thought-constellation: http routes');
  });
}
